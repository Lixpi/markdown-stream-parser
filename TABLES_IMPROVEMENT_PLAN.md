# Plan: Improve Markdown Table Parsing (LIX-MDSP-7/tables-support)

## Context

The tree-sitter streaming parser has partial table support: it detects `table`/`table_row`/`table_cell` blocks, suppresses pipes and delimiter rows, and handles header reclassification via backtrack. Gaps: header cells are folded into `table_cell` (renderers can't emit `<th>`), column alignment from the delimiter row is discarded, streaming edge cases are under-tested, and table logic is scattered across four files. Legacy `src/state-machine/` is dead code — ignored entirely. All code runs inside the `lixpi-markdown-stream-parser-demo` docker service.

## Steps

### 1. Types and public contract
- In `src/tree-sitter/types.ts`: add `'table_header_cell'` to `BlockType` union (~line 46), add `TableAlignment = 'left' | 'center' | 'right'`, add `TableMetadata = { tableId: string; rowIndex: number; columnIndex: number; cellId: string; align?: TableAlignment }`, and add `table?: TableMetadata` to `BlockContext` and internal `BlockInfo`
- `tableId` must be deterministic from table structure and stable across backtrack replay; use a source-derived key such as the enclosing `pipe_table.startIndex`, not a raw tree-sitter `Node.id`.
- `cellId` must be deterministic and stream-unique, e.g. `${tableId}:${rowIndex}:${columnIndex}`. This prevents adjacent tables from merging when two tables both contain a local `0:0` cell and gives consumers a stable way to group word-sized chunks from the same markdown cell.
- In `src/tree-sitter-markdown-stream-parser.ts` and `src/markdown-stream-parser.ts`: re-export `TableAlignment` and `TableMetadata` if they are named public types
- In `README.md`: document `table_header_cell`, `block.table.tableId`, `block.table.rowIndex`, `block.table.columnIndex`, `block.table.cellId`, and `block.table.align`; add a compatibility note for consumers that previously treated all header chunks as `table_cell`

Breaking only for consumers that expect header cells as `table_cell` — that's the point of the change. There is no changelog file currently; record the compatibility note in README or add a dedicated changelog/release note file as part of this change.

### 2. New module `src/tree-sitter/table-support.ts` (precedent: `list-support.ts`)
Pure Node-walking functions:
- `isInsideTableDelimiterRow(node)` — extracted from `segment-generator.ts:569-583`
- `getTableAlignments(tableNode)` — parse `pipe_table_delimiter_cell` text (`:---`/`:---:`/`---:`) → normalized alignment per column
- `getColumnIndex(cellNode)` — count preceding `pipe_table_cell` siblings only
- `getRowIndex(rowNode)` — count preceding `pipe_table_header`/`pipe_table_row` siblings only; header row is `0`
- `getTableId(tableNode)` — deterministic public table key, e.g. `table:${tableNode.startIndex}`
- `getCellId(tableId, rowIndex, columnIndex)` — deterministic public grouping key, e.g. `${tableId}:${rowIndex}:${columnIndex}`
- `getTableBlockInfo(node, list?)` — the table branch of `getBlockInfo` moved here; returns `BlockInfo` incl. `table: { tableId, rowIndex, columnIndex, cellId, align? }`

Keep `isHeader` out of public `TableMetadata` unless a consumer need appears; `table_header_cell` already exposes header-ness.

### 3. Delegation
- `block-detection.ts:39-62`: replace table case cluster with `getTableBlockInfo(node, list)` call (same pattern as `getListMetadata`); keep `getListMetadata(node)` owned by `getBlockInfo()` so table support does not duplicate list walks/imports
- Remove the now-dead `id` field: the table branches (`block-detection.ts:47,53,59`) are the only place it is ever set and nothing reads it (`isNewBlock` compares type/level/startIndex; `createBlockContext` never copies it), so also delete `id?: number` from `BlockInfo` in `types.ts:189`
- `segment-builder.ts:67-75`: map `table_header_cell` → `table_header_cell` (stop folding); copy `blockInfo.table` in `createBlockContext` (like `list`/`language`)
- Carry explicit table metadata through `BlockContext`; do not use internal `BlockInfo.id` for public grouping

### 4. `segment-generator.ts`
- Replace inline delimiter walk (569-583) with `isInsideTableDelimiterRow()`
- Alignment flows automatically via existing BlockInfo → BlockContext → chunk path. Timing: header cells emitted pre-delimiter parse as paragraph; the existing backtrack re-emits them as `table_header_cell` with `align` once the delimiter row is in the tree. Body cells carry `tableId`, `rowIndex`, `columnIndex`, `cellId`, and `align` when specified by the delimiter row.
- Robustness fixes driven by Step 6 tests. Known suspects:
  - Cell identity/grouping: current chunks are word-sized, so one markdown cell may produce multiple chunks. Group by explicit `table.cellId`; never rely on `blockInfo.id`
  - Delimiter row split across chunks transiently parsing as body row (leaking `---`) — verify backtrack corrects; fix empirically
  - `windowSize` overflow during header reclassification → must yield `recovery: window_overflow`, not corruption

### 5. Demo (`demo/svelte-demo/src/routes/+page.svelte`)
- Include `table_header_cell` in `hasTableCells` (~line 521)
- Add header-cell rendering branch (~line 689, bold/th-style) and apply `chunk.block.table?.align` as text alignment on cells
- Do not render every chunk as its own bordered cell. The token buffer emits word-sized chunks, so cells like `New York` can become multiple `table_cell` chunks. Build table display groups by `chunk.block.table.tableId`, then `rowIndex`, then `cellId`; render rows/cells from those groups. This also prevents adjacent tables with matching local row/column positions from merging.
- Keep alignment application closed over known values (`left`/`center`/`right`) via classes or controlled style values; never pass raw delimiter text into a `style` attribute

### 6. Tests (`src/tree-sitter-markdown-stream-parser.test.ts`, new `describe('Table Support')`)
- Header cells → `table_header_cell`, body → `table_cell` (update existing test at 971-983)
- Alignment left/center/right/undefined + `tableId` + `rowIndex` + `columnIndex` + stable stream-unique `cellId`
- Chunked streaming helper, sizes 1/2/3: no `|`/`---` leakage in reconstructed active output; pipe split across chunks; delimiter row split mid-cell; table at stream start/end; table after paragraph and after list (no `list` metadata bleed)
- Backtrack: re-emitted header chunks carry type + align; small-`windowSize` recovery test
- When asserting leakage or final content, reconstruct the active stream after applying `backtrackOffset`; raw emitted event history may contain transient paragraph chunks before table reclassification
- Multi-word cell test: verify chunks in one cell can be grouped/rendered as one cell, not separate bordered cells
- Adjacent tables test: two separate tables with local cell `0:0` must have different `tableId`/`cellId` and must not merge in demo grouping
- Optional: table fixture JSON in `demo/llm-streams-examples/` for debug runs

## Files
- New: `src/tree-sitter/table-support.ts`
- Modify: `src/tree-sitter/types.ts`, `block-detection.ts`, `segment-builder.ts`, `segment-generator.ts`, `src/tree-sitter-markdown-stream-parser.ts`, `src/markdown-stream-parser.ts`, `src/tree-sitter-markdown-stream-parser.test.ts`, `README.md`, `demo/svelte-demo/src/routes/+page.svelte`

## Verification (all in docker)
```
docker compose up -d
docker exec lixpi-markdown-stream-parser-demo pnpm test:run
docker exec lixpi-markdown-stream-parser-demo pnpm run debug-parser-tree-sitter --file=demo/llm-streams-examples/<table-fixture>.json
```
Visual check: svelte demo dev server (imports `src/` directly) — header row styled, alignment applied.
