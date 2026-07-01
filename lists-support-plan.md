# Reliable List Support

## Summary

Add robust ordered, unordered, nested, loose, and task-list handling to the tree-sitter parser. Keep `block.type === 'list_item'` for list item text, and add optional list metadata so consumers can render bullets, numbers, nesting, and checked state without parsing raw Markdown.

## Public API Changes

Extend `BlockContext` with optional metadata:

```ts
list?: {
  type: 'ordered' | 'unordered'
  depth: number
  marker: '-' | '+' | '*' | '.' | ')'
  ordinal?: number
  task?: { checked: boolean }
}
```

- `depth` is zero-based: top-level list items use `0`, nested list items use `1+`. Compute it as the number of enclosing `list` ancestors minus one.
- For **unordered** lists, `marker` is the bullet character (`-`, `+`, `*`) and `ordinal` is absent.
- For **ordered** lists, `marker` is the *delimiter only* (`.` or `)`); the number lives in `ordinal` when it is safely representable as a JavaScript number. This is documented explicitly because `marker` alone does not reconstruct the source (`"1."` = `ordinal: 1` + `marker: '.'`).
- Task list items strip `[x]`, `[X]`, or `[ ]` (and the following space) from rendered text and expose `task.checked`.

## Grammar Facts (verified against the bundled WASM)

These node shapes drive the design and were confirmed by dumping the AST for representative inputs:

```
"- [x] done\n"
  list_item
    list_marker_minus          [0,2]  "- "
    task_list_marker_checked   [2,5]  "[x]"     ← node covers "[x]" only, not the trailing space
    paragraph                  [6,11] "done\n"  ← index 5 (the space) belongs to NO node
      inline                   [6,10] "done"

"- Parent\n  - Child\n"
  list_item
    list_marker_minus  [0,2]
    paragraph          [2,11] "Parent\n  "
      inline           [2,8]  "Parent"
      block_continuation [9,11] "  "            ← indent hangs on the PARENT paragraph; \n at 8 is a gap
    list (nested) …
```

Consequences:

- Every list/task marker is a **discrete sibling node**, exactly like the markers `SUPPRESSED_SYNTAX_TYPES` already drops — so suppression can be *extended*, not replaced.
- `task_list_marker_*` nodes exclude the trailing space; that space (index 5 above) is an orphan gap owned by no node and must be handled explicitly.
- `block_continuation` is a standalone leaf node, but it is not safe to drop with the existing whole-segment suppression path because a streamed range can start on the continuation and extend into real content. It is also **not list-only** (blockquotes and loose-list blanks produce it), so range-aware filtering must be scoped to list ancestry.
- Ordered `1)` and `1.` parse as **separate `list` nodes**; derive metadata from the marker node, never from assumed list continuity.

## Implementation Changes

The approach is **extend the existing node-suppression path first**, and use small scoped range filtering only for source slices that bypass node-at-position suppression. Node suppression already keeps rendered-offset accounting correct for free (it advances `sourceOffset` without advancing `totalUtf16Offset`), which preserves chunk offsets, span offsets, backtracking, and checkpoints without broad new offset math.

1. **List metadata helpers (AST-derived, stateless).**
   - Add helpers to find the enclosing `list_item`, read the marker node type/text, compute `ordered`/`unordered`, extract `ordinal` from the ordered marker text, read `task.checked` from a `task_list_marker_checked` / `task_list_marker_unchecked` sibling, and compute zero-based `depth` as `listAncestorCount - 1`.
   - Metadata is a pure function of the node, so it is re-derived per chunk and is inherently backtrack-safe (no dependence on checkpoint state).
   - `ordinal` is parsed from the leading digits of the marker text. If the value is greater than `Number.MAX_SAFE_INTEGER`, omit `ordinal` rather than emitting a lossy number.

2. **Thread metadata through the internal types.**
   - Extend internal `BlockInfo` (and `BlockState`, if list data is retained across chunks) with the list fields.
   - Derive list metadata by scanning the full ancestor chain independently from block type selection. Do not rely on `getBlockInfo` reaching `list_item`, because nested blocks such as `fenced_code_block` currently return before the walk reaches their enclosing list item.
   - Nested blocks (e.g. a code block inside a list) keep their natural `BlockInfo.type` and *also* receive list metadata.
   - `createBlockContext` / `mapBlockType` (segment-builder.ts) copy the list metadata onto the public `BlockContext`. `BlockContext.list` is only set inside list context.

3. **Extend suppression to the new marker nodes.**
   - Add `task_list_marker_checked` and `task_list_marker_unchecked` to the suppressed syntax types.
   - Do **not** add `block_continuation` to the existing whole-segment early-suppression branch. That branch drops the entire incoming range when `nodeAtPosition` is suppressed; for list-contained code blocks, a streamed range can start on a structural continuation node and continue into real code text.
   - Handle list-scoped `block_continuation` with range-aware filtering/splitting instead: remove only the exact continuation-node range, or early-suppress only when `[actualFromIndex, actualToIndex)` is fully contained within that continuation node.
   - After stripping a *leading* continuation prefix, re-derive the block/node for the remainder from the post-continuation position. Do not classify or extract the remaining content against the `block_continuation` node it started on.
   - Apply this only when the `block_continuation` has an enclosing `list_item` ancestor before any enclosing `blockquote` ancestor. Do not use "nearest block ancestor" because `paragraph` is also a block type. This is the one conditional suppression and must not over-reach.

4. **Handle the orphan task-marker space.**
   - The space between a task marker and its paragraph is owned by no node; without handling it leaks as a lone `" "` `list_item` chunk. Strip it by extending the suppressed task-marker range to swallow following spaces up to, but not including, a newline. Do **not** strip the item's trailing `\n` — existing behavior retains it (e.g. `'Run npm install now\n'`), and that contract stays.

5. **Filter post-inline structural tails.**
   - Current generation appends source text after the inline node directly. That path can leak list structural text such as `\n  ` / `block_continuation` even when node suppression handles normal marker ranges.
   - Before appending `content.substring(Math.max(actualFromIndex, hostInlineNode.endIndex), actualToIndex)`, remove list-scoped suppressed ranges from that tail using the same suppression decision as marker/task/block-continuation handling.
   - Keep real rendered newlines that belong to item text; only remove structural continuation indentation and stripped task-marker spaces.

6. **Filter list continuations inside code-block extraction.**
   - The motivating list-contained code-block case flows through the `getCodeBlockContent` branch, not the generic inline/tail path.
   - `getCodeBlockContent` currently skips only `fenced_code_block_delimiter` and `info_string`; also remove list-scoped `block_continuation` ranges there so list indentation around fences and code lines does not leak.
   - Preserve code content after a stripped continuation prefix. For example, when a source range starts with structural list indentation and then real code text, strip only the structural prefix and emit the remaining code text as `block.type: 'code_block'`.

7. **Consolidate duplicated constants (DRY, done as part of this change).**
   - Replace the local copies `SUPPRESSED_SYNTAX_TYPES_LOCAL` and `HEADER_MARKER_LEVELS_LOCAL` in `segment-generator.ts` with the exported constants from `types.ts`, so the new marker types are added in exactly one place.

8. **Docs.** Update README supported-Markdown/API docs, including moving task lists out of Limitations and documenting the `block.list` shape and the ordered `marker`/`ordinal` split.

## Offset & Recovery Notes

- Because node suppression handles marker nodes directly, `rawToRenderedOffset` / `collectInlineDelimiterRanges` need **no** list awareness for markers that are their own nodes. Range filtering is limited to orphan task-marker spaces and list-scoped structural continuations, including code-block extraction and post-inline tails that bypass node-at-position suppression.
- The one place to verify carefully is **spans inside a task item**: the `inline` node starts after `[x] ` / `[X] ` / `[ ] `, so a span must render as if the prefix never existed. Confirm `chunkStartUtf16` base math holds when the suppressed prefix and the span text fall in the same word-range/chunk. This is the primary correctness risk and gets a dedicated exact-offset test.
- Split-marker streaming (`-` then ` `; `1` then `.` then ` `) briefly parses as paragraph/other, then backtracks once the marker resolves. Metadata is re-derived from the post-backtrack AST, so assertions target post-backtrack output.
- Checkpoints shallow-copy `currentBlock`; if list metadata is stored there, clone the nested `list` object in checkpoint creation/restoration or treat it as immutable for the full generator lifecycle.

## Test Plan

- Unordered markers `-`, `+`, `*`; ordered markers `1.`, `10.`, `1)`, asserting exact `ordinal` (e.g. `10`) and `marker` values, not just detection.
- Ordered marker with a number greater than `Number.MAX_SAFE_INTEGER`: assert `marker` is present and `ordinal` is omitted.
- Nested lists: assert exact zero-based `depth` per level and that no structural indentation (`block_continuation`) leaks into rendered text.
- Loose lists: blank-line items still classify as list items and no indentation leaks.
- Task lists: checked and unchecked items, including uppercase `[X]`, rendered text without `[x]` / `[X]` / `[ ]` **and** without the following space, `task.checked` correct, and the item's trailing `\n` preserved.
- Streaming split-marker tests: `'-'`, `' '`, `'Item\n'`; `'1'`, `'.'`, `' '`, `'Item\n'`; split task-marker chunks — asserting post-backtrack metadata and text.
- Inline span inside a list/task item: assert exact span `offset` and `length` after the stripped list/task syntax (the core offset regression guard).
- List-contained code block: list indentation/fence syntax does not leak through `getCodeBlockContent`, code text after stripped continuation prefixes is preserved, and `block.list` metadata is preserved alongside `block.type: 'code_block'`.
- **Negative tests (guard over-broad suppression):** non-list blockquote continuation still renders its text, and a loose-list blank line does not swallow adjacent content. These ensure the list-scoped `block_continuation` rule does not strip non-list continuations.
- **List inside a blockquote** (`> - a\n>   - b\n`): the continuation node's text is `">   "` (it carries the `>` marker), and because it is structural continuation inside a list item, suppress it — assert neither the indent nor the `>` leaks into rendered item text.
- Run verification inside `lixpi-markdown-stream-parser-demo`:

```sh
docker exec lixpi-markdown-stream-parser-demo pnpm test:run
```

## Assumptions

- The change targets the tree-sitter parser path, which is the public documented parser.
- Existing consumers remain compatible because list metadata is optional and existing `block.type` values are preserved.
- Blockquote behavior inside lists remains limited to current blockquote support unless separately requested.
- The bundled grammar emits `task_list_marker_checked` / `task_list_marker_unchecked` (verified against the WASM in `demo/svelte-demo/static`); no GFM extension toggle is required.
