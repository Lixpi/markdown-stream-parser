# Migrate svelte-demo rendering to ProseMirror (LIX-MDSP-20)

## Context

The demo at `demo/svelte-demo` currently renders the parser's streaming output with an ad-hoc, hand-written rendering layer inside `src/routes/+page.svelte` (~898 lines): a reactive block-grouping state machine (`parsedBlocks`), manual open-span tracking, table reconstruction (`buildTableRows`), and a giant `{#each}/{#if}` markup tree with Tailwind span classes. This is the "legacy state-machine code" to replace.

Goal: replace that rendering layer with ProseMirror, following the architecture of the Lixpi main repo (workspace-local shallow clone currently available at `/tmp/claude-1000/-home-dima-Desktop-markdown-stream-parser/8b99adf2-a3b8-4241-898c-740929163041/scratchpad/lixpi-ref`; do not rely on this path outside this workspace): a framework-free ProseMirror module (schema + pure stream-assembly functions) driving an `EditorView` via transactions.

**Key adaptation vs Lixpi:** Lixpi's `packages/lixpi/prosemirror/src/stream-assembly.ts` consumes the OLD parser segment shape (`{segment, styles[], type, isBlockDefining}`). This repo's tree-sitter parser emits a new offset-based `Chunk` shape (`src/tree-sitter/types.ts`): `{text, offset, length, block:{type, level?, language?, list?, table?}, opening/closing/contained spans, backtrackOffset?, recovery?}` wrapped in `StreamingChunk` (`START_STREAM | STREAMING | END_STREAM`). Lixpi's schema also lacks list/table nodes, which this parser emits. So we replicate the *architecture*, not the code verbatim.

**User-approved decisions:**
- **Rebuild projection** strategy: keep a chunk buffer; on each chunk rebuild the whole doc via a pure `chunks → doc` function and dispatch one replace transaction. Backtracking = filter buffer; reset/replay = clear buffer. Demo-scale docs make O(n) rebuild imperceptible.
- **Location**: `demo/svelte-demo/src/lib/prosemirror/` (framework-free TS, promotable to a package later; repo stays single-package).
- Hand-written NodeSpecs for lists/tables (no `prosemirror-schema-list`/`prosemirror-tables` — those provide editing commands we don't need for a read-only view; Lixpi hand-writes all specs too).
- All commands run inside docker container `lixpi-markdown-stream-parser-demo`.

## New files (all under `demo/svelte-demo/src/lib/prosemirror/`)

### 1. `schema.ts`
Adapt Lixpi's `base-schema.ts` (scratchpad ref above), extend with lists/tables, drop lixpi-only nodes. Read-only view ⇒ `parseDOM` optional.

Nodes:
- `doc` (`block+`), `paragraph` (`inline*` → `['p', 0]`), `heading` (attr `level`, → `h1..h6`), `code_block` (attr `language`, `content:'text*'`, `marks:''`, `code:true`, → `['pre', {'data-language': language}, ['code', 0]]`), `blockquote` (`block+`), `text`
- `bullet_list` (`list_item+` → `['ul', 0]`), `ordered_list` (attr `order` → `['ol', {start}, 0]`), `list_item` (attr `task: null|{checked}`, `content:'block+'`, → `['li', {'data-task': checked|unchecked}, 0]`)
- `table` (`table_row+` → `['table', ['tbody', 0]]`), `table_row` (`(table_header_cell|table_cell)+` → `['tr', 0]`), `table_header_cell`/`table_cell` (attr `align`, `content:'inline*'`, → `['th'|'td', {style:'text-align: ...'}, 0]`)
- `image` — **inline** (`inline:true`, group `inline`, attrs `src`, `alt`) since the parser emits images as inline spans

Marks (per Lixpi's `createStreamingMark` mapping): `strong`, `em`, `code`, `strikethrough` (→ `<s>`), `link` (attr `href`, `inclusive:false`, render with `rel="noopener noreferrer"`).

Security: parser span metadata is untrusted text. Before creating link marks or image nodes, sanitize URLs with a single helper used by stream assembly:
- Links: allow `http:`, `https:`, and `mailto:` only; reject empty, malformed, `javascript:`, `vbscript:`, and `data:` URLs.
- Images: allow `http:`, `https:`, root-relative/path-relative URLs, and safe `data:image/*` URLs only; reject protocol-relative URLs, scriptable URLs, and non-image data URLs.
- Rejected links/images render as their plain covered text, not as clickable links or image nodes.

### 2. `stream-assembly.ts`
Pure, no DOM/Svelte. Import types from `../../../../../src/markdown-stream-parser.ts` (same relative-source style `+page.svelte` already uses).

```ts
// backtrack semantics: if chunk.backtrackOffset set, drop buffered chunks with
// (offset + length) > backtrackOffset, then append (proven predicate, +page.svelte:180-188)
applyStreamingChunkToBuffer(buffer: Chunk[], chunk: Chunk): Chunk[]

// shared predicate so editor buffer and +page.svelte debug parsedSegments cannot drift
isChunkBeforeBacktrack(chunk: Chunk, backtrackOffset: number): boolean

sanitizeLinkHref(rawHref: string): string | null
sanitizeImageSrc(rawSrc: string): string | null

// port of the parsedBlocks state machine (+page.svelte:382-441): boundaries on
// block.type change (except same-tableId cells), tableId change, heading level change,
// list newline heuristic; ADD: list depth/type change also starts a new group
groupChunksIntoBlocks(chunks: Chunk[]): Chunk[][]

// slice chunk text at span boundaries (absolute UTF-16 offsets); active spans =
// carried-open ∪ opening ∪ covering-contained − closed; image spans → inline image
// node replacing covered text; others → marks (bold→strong, italic→em, code→code,
// strikethrough→strikethrough, link→link{href:sanitizedUrl}). Rejected unsafe URLs
// render as plain covered text. Skip empty runs.
buildInlineContent(schema: Schema, blockChunks: Chunk[]): Node[]

// fold groups into nodes: paragraph/heading{level}/code_block{language}/
// blockquote(paragraph)/list depth-stack (nested bullet_list/ordered_list, ordinal→order,
// task attr)/table grouping by tableId with rowIndex/columnIndex ordering + cellId dedup
// (port buildTableRows, +page.svelte:334-373). Empty buffer → doc(paragraph).
// try/catch per block → fallback plain paragraph so mid-stream states never throw.
buildDocFromChunks(schema: Schema, chunks: Chunk[]): Node
```

Notes: trim one trailing `\n` per non-code block group; tolerate partial table rows mid-stream; open link/image spans have no url/src until closed — render as plain text until closure (rebuild fixes retroactively).

### 3. `editor.ts`
```ts
createStreamRenderer(mount: HTMLElement): StreamRenderer
// StreamRenderer: { handleStreamingChunk(parsed: StreamingChunk): void; reset(): void; destroy(): void }
```
- `new EditorView(mount, { state: EditorState.create({schema, doc: emptyDoc}), editable: () => false })`
- Private non-reactive `buffer: Chunk[]`. On `STREAMING`: update buffer, `nextDoc = buildDocFromChunks(...)`, skip if `nextDoc.eq(state.doc)`, else `dispatch(tr.replaceWith(0, doc.content.size, nextDoc.content))`
- On `START_STREAM`: internal `reset()` (restart per stream, not append across runs). `console.warn` on `recovery.type === 'window_overflow'`.

### 4. `ProseMirrorRenderer.svelte`
Mirrors Lixpi's `ProseMirror.svelte` mount pattern: `bind:this={mountEl}` div with `class="prose prose-sm max-w-none"`, `onMount` → `createStreamRenderer`, `onDestroy` → `destroy()`. Exports `handleStreamingChunk` / `reset` for `bind:this` use from the page.

### 5. `prosemirror.css`
- `.ProseMirror { outline: none; word-wrap: break-word; }` (no global `pre-wrap`; trim newlines in assembly instead)
- Task-list checkboxes via `li[data-task]::before` (☐/☑), code-block language badge via `pre[data-language]::after`, table `th/td` borders to match old look.

## Modified files

### `demo/svelte-demo/src/routes/+page.svelte`
- Replace the `{#each parsedBlocks ...}` markup (lines ~596–829) with `<ProseMirrorRenderer bind:this={pmRenderer} />` in the same card div.
- Subscription callback (~135–198): add `pmRenderer?.handleStreamingChunk(parsed)`; keep `parsedSegments` accumulation + backtrack filtering (feeds debug columns) and the backtrack `console.warn`.
- `resetParser()` (~302): add `pmRenderer?.reset()`.
- Delete dead code: `parsedBlocks` reactive block, `buildTableRows`, `getTableAlignClass`, `getTableCellAlignClass`, `isTableCellBlockType`, `getSpanClasses`, `hasCodeStyle`, `getActiveSpanTypes`, `updateOpenSpans` + `openSpans` state, `TableCellGroup`/`TableRowGroup`/`TableAlign` types.
- Keep: example picker, delay slider, play/pause/step/reset, and all debug columns (Current Token, Parsed Chunks JSON, raw tokens, concatenated txt).

### `demo/svelte-demo/package.json` and `demo/svelte-demo/pnpm-lock.yaml`
Add direct dependencies actually imported by the implementation: `prosemirror-model`, `prosemirror-state`, and `prosemirror-view`. Add `prosemirror-transform` only if implementation code imports it directly. Add `vitest` as a devDependency plus a `test` script because the demo package currently has `check` but no test runner.

### `demo/svelte-demo/src/lib/prosemirror/stream-assembly.test.ts`
Add focused unit tests for the pure assembly layer, including URL sanitization and shared backtrack behavior.

### `demo/svelte-demo/src/app.css`
Add `@import './lib/prosemirror/prosemirror.css';` (Tailwind v4 CSS-first; typography plugin already loaded).

## Implementation order

1. `docker compose up -d`; then `docker exec lixpi-markdown-stream-parser-demo pnpm --dir demo/svelte-demo add prosemirror-model prosemirror-state prosemirror-view` (add `prosemirror-transform` only if directly imported)
2. Add the demo test runner: `docker exec lixpi-markdown-stream-parser-demo pnpm --dir demo/svelte-demo add -D vitest`, then add a `test` script.
3. Implement `schema.ts`
4. Implement `stream-assembly.ts` (port grouping/table logic from `+page.svelte`)
5. Add `stream-assembly.test.ts` for the pure assembly layer.
6. Implement `editor.ts` + `ProseMirrorRenderer.svelte` + `prosemirror.css` + `app.css` import
7. Wire into `+page.svelte`, delete legacy rendering
8. Run tests and typecheck: `docker exec lixpi-markdown-stream-parser-demo pnpm --dir demo/svelte-demo run test` and `docker exec lixpi-markdown-stream-parser-demo pnpm --dir demo/svelte-demo run check`

## Verification (all inside the container)

1. Add focused unit tests for `stream-assembly.ts`: backtrack filtering shared by buffer/debug paths, nested lists, ordered-list start attrs, task lists, tables, link/image URL sanitization and rejection, open/closed/contained spans, zero-length text skipping, and malformed mid-stream states falling back instead of throwing.
2. Run the unit tests inside the container.
3. `docker exec -d lixpi-markdown-stream-parser-demo pnpm --dir demo/svelte-demo run dev` (predev regenerates the manifest; binds 0.0.0.0:5173 → host 5173). Open `http://localhost:5173`.
4. Exercise examples from `demo/svelte-demo/static/llm-streams-examples/`:
   - headings/paragraphs/bold/italic/lists: `claude-3.5-1-quantum-physics`, `gpt-4.o-history-of-cats`
   - fenced code blocks + language: `claude-3.7-happy-number-5-programs`, `gpt-4.5-cat-coding`
   - **backtracking**: `claude-3.7-markdown-with-nested-code-block`, `test-error-recovery` — watch for `⚠️ BACKTRACK` console warning; PM doc must self-correct with no stale/duplicated text
   - strikethrough: `test-strikethrough`; find table/task-list examples via `grep -l '|' static/llm-streams-examples/*.txt` and `grep -l '\- \['`
5. Controls: full play to END_STREAM; pause + single-step (doc updates chunk-by-chunk); reset mid-stream (doc clears); replay after completion (restarts, doesn't append); switch example mid-stream.
6. Debug columns still behave identically.
7. `pnpm --dir demo/svelte-demo run check` passes.

## Risks / notes

- Backtrack filter predicate `chunk.offset + chunk.length <= backtrackOffset` is the proven one from the legacy code — expose it once and reuse it for both the ProseMirror chunk buffer and debug `parsedSegments`.
- ProseMirror `toDOM` specs are nested arrays; strings like `table>tbody` are documentation shorthand only and must not be used as literal tag names.
- Sanitization belongs before ProseMirror mark/node creation; do not rely on DOM escaping to make `href`/`src` safe. Implement it as exported pure helpers so behavior is unit-testable without a browser.
- Legacy list-item newline grouping heuristic is imperfect; keep for parity plus the added depth/type boundary rule.
- ProseMirror text nodes can't be empty — skip zero-length runs.
- `+page.svelte` uses Svelte legacy syntax under Svelte 5 (`$:`/`on:click`) — keep new code consistent (onMount/bind:this), don't convert the page to runes.
