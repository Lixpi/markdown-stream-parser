# Error Recovery: Scaling and Window Semantics

This note describes three engineering improvements needed to keep Markdown error recovery correct and efficient for long streams:

1. Checkpoint pruning and indexing
2. Eliminating full-tree scans
3. Defining strict `windowSize` behavior

## Checkpoint pruning and indexing

A checkpoint stores enough parser state to restart segment generation from a previous source position.

The current implementation adds checkpoints frequently and copies the complete checkpoint array whenever it adds one:

```ts
const checkpoints = [...state.checkpoints, checkpoint]
```

For `n` emitted segments, repeated array copying approaches O(n²). Checkpoint lookup also scans the array linearly.

### Recommended design

- Create checkpoints only at stable boundaries:
  - End of paragraph
  - End of heading
  - Complete list item
  - Code fence boundary
  - A configurable source-character interval
- Retain only checkpoints inside the supported recovery window.
- Retain one older baseline checkpoint when unlimited recovery is required.
- Index checkpoints by source and rendered offsets.
- Use binary search to select the latest valid checkpoint.
- Keep the checkpoint collection in mutable parser-internal storage instead of copying it into every generator state.

```text
source:       0───100───200───300───400
checkpoints:       C1     C2     C3     C4
                             ^
                       changed region
```

Recovery should select `C2` using an indexed lookup and replay from that checkpoint.

This changes checkpoint lookup from O(n) to O(log n), avoids repeated history copying, and prevents unbounded checkpoint growth.

## Eliminating full-tree scans

After each streamed token, the current parser recursively scans the complete syntax tree to find the earliest error.

For a growing document, the cumulative work can become quadratic:

```text
chunk 1: scan 100 nodes
chunk 2: scan 200 nodes
chunk 3: scan 300 nodes
...
```

Tree-sitter already reports changed ranges. Error inspection should normally be limited to:

- Changed ranges
- Their containing block nodes
- A small surrounding recovery region
- Previously tracked unresolved errors that overlap the new changes

The processing flow should be:

```text
append token
    ↓
Tree-sitter returns changed ranges
    ↓
inspect affected blocks or subtrees
    ↓
recover only if previously emitted output was affected
```

For example, when a delimiter row reclassifies a preceding line as a table header, the parser should inspect the affected table subtree instead of rescanning unrelated headings and paragraphs.

Unresolved errors can be tracked explicitly:

```ts
type PendingError = {
    sourceStart: number
    sourceEnd: number
    containingBlockStart: number
}
```

When new input arrives, the parser revisits only pending errors that overlap or are structurally related to the changed ranges.

## Strict `windowSize` behavior

`windowSize` represents how far back a consumer can revise already-rendered output.

```text
rendered output length:   1,000
windowSize:                 100
earliest legal backtrack:   900
```

If tree-sitter discovers that output beginning at offset 700 is incorrect, the parser cannot start recovery at 900 and claim that the correction is complete. The structural change began before the recoverable window.

### Required invariant

The selected checkpoint must never occur after the earliest affected source position:

```text
selected checkpoint source offset <= earliest affected source offset
```

Without this invariant, replay can start after the damaged region and produce output that appears valid but is internally inconsistent.

### Possible overflow policies

#### Strict failure

Emit an explicit event when the required recovery exceeds the consumer's supported window:

```ts
{
    status: 'RECOVERY_LIMIT_EXCEEDED',
    requiredOffset: 700,
    earliestAllowedOffset: 900
}
```

The consumer can then restart parsing or request a complete replacement.

#### Full snapshot replacement

Emit the complete corrected document or affected block instead of attempting a partial backtrack.

#### Block-level recovery

Treat `windowSize` as a target while permitting recovery to extend to the beginning of the affected Markdown block. This is practical for Markdown, but the behavior must be part of the public contract.

### Recommended contract

1. Determine the earliest affected source position.
2. Select the latest checkpoint at or before that position.
3. Translate that checkpoint to its rendered offset.
4. If the rendered offset violates `windowSize`, emit an explicit recovery-limit event.
5. Optionally apply a configured fallback, such as full snapshot replacement.
6. Never silently select a later checkpoint to satisfy the window.

## Suggested implementation order

1. Define and test the `windowSize` overflow contract.
2. Move checkpoint storage out of copied generator state.
3. Add checkpoint pruning and binary-search lookup.
4. Restrict error detection to changed subtrees and tracked pending errors.
5. Add long-stream benchmarks and recovery correctness tests.

