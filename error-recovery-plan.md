# Tree-Sitter Recovery Implementation Plan

## Summary

- [x] Migrate the public package API to the tree-sitter parser; README already documents the async tree-sitter API.
- [x] Make all public offsets rendered-output UTF-16 offsets: `chunk.offset`, `chunk.length`, `OpenSpan.openOffset`, `ClosedSpan.offset`, `ClosedSpan.length`, and `backtrackOffset`.
- [x] Use tree-sitter recovery signals fully: changed ranges plus explicit `ERROR`/missing nodes from block and inline trees.
- [x] Preserve the current Docker test baseline and add focused recovery/build coverage.

## Package Entrypoint

- [x] Replace `src/markdown-stream-parser.ts` with a public re-export or wrapper around `src/tree-sitter-markdown-stream-parser.ts`.
- [x] Update legacy entrypoint tests to the async tree-sitter API.
- [x] Keep the build entry at `src/markdown-stream-parser.ts` so package exports stay stable.
- [x] Ensure runtime tree-sitter dependencies are in `dependencies`, not only `devDependencies`.
- [x] Add a package build smoke test that imports from `build/markdown-stream-parser.js`.

## Offset Model

- [x] Refactor generator state to track source offsets and rendered offsets separately.
- [x] Advance public rendered offsets only by emitted text, not stripped markdown markers or suppressed syntax.
- [x] Convert `OpenSpan` and `ClosedSpan` positions/lengths to rendered offsets.
- [x] Keep `chunk.original` as raw source when `includeRawStreamedToken` is enabled.
- [x] Apply `windowSize` to rendered offsets, because consumers discard rendered output.

## Recovery Flow

- [x] Find earliest affected source offset from `getChangedRanges()`.
- [x] Include explicit tree-sitter `ERROR` and missing nodes in affected-range detection.
- [x] Store generator checkpoints at stable emitted boundaries: source offset, rendered offset, open spans, pending inline state, accumulated content, and block state.
- [x] Rebuild recovery output from the nearest stable checkpoint before the affected source offset.
- [x] Emit `backtrackOffset` on the first correction chunk using rendered-offset coordinates.
- [x] Emit a zero-length correction chunk when recovery deletes stale output without replacement.
- [x] Prevent stale or duplicated chunks after repeated recovery events.

## Tests

- [x] Add exact rendered-offset tests for headings, inline styles, and code blocks after marker stripping.
- [x] Add table reclassification recovery after preceding heading/paragraph markdown.
- [x] Add code fence split-across-chunks coverage.
- [x] Add code fence reclassification recovery after emitted paragraph text.
- [x] Add unclosed code fence at stream end coverage.
- [x] Add code fence rendered-offset coverage after preceding markdown syntax.
- [ ] Add inline delimiter recovery with open/closing spans.
- [ ] Add recovery test for stale output deletion without replacement.
- [x] Add `windowSize` recovery test using rendered distance.
- [x] Add `includeRawStreamedToken` recovery test.
- [x] Strengthen consumer simulation tests to apply `backtrackOffset` to a rendered string buffer.

## Integration Cleanup

- [x] Update demo/debug utilities that import `tree-sitter-markdown-stream-parser` directly when package entrypoint migration is complete.
- [x] Update any old `{ status: "STREAMING", segment }` assumptions to the tree-sitter `{ status: "STREAMING", chunk }` shape.
- [x] Fix TypeScript build issues around `web-tree-sitter` types and nullable parse results.

## Verification

- [x] Run full tests in a one-off Docker container mounted to this workspace.
- [x] Run `pnpm run build` or the Docker equivalent.
- [x] Document any remaining skipped tests or known limitations.

## Remaining Follow-Up

- [x] Add explicit code fence recovery coverage:
  - [x] Split fence across chunks strips markers and emits `code_block`.
  - [x] Reclassification after emitted paragraph text applies corrected output.
  - [x] Unclosed fence at stream end emits code content without stuck buffering.
  - [x] Fence after stripped markdown syntax uses rendered offsets.
  - [x] Remove `handleCodeFenceInParagraph` after tests prove tree-sitter parsing covers these cases.
- [ ] Add inline delimiter recovery coverage that asserts open/closing spans through replay.
- [ ] Add a direct stale-output deletion recovery case that exercises the zero-length correction chunk path.
- [ ] Existing skipped feature tests remain skipped for blockquotes and fuller table support; they are outside this recovery pass.
