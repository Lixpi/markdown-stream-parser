import type { Parser, Tree, Node } from 'web-tree-sitter'

// ============================================================================
// SPAN TYPES - Typed spans with metadata
// ============================================================================

// Typed span with metadata. Plain strings don't scale —
// links need URLs, images need src/alt, etc.
export type Span =
    | { type: 'bold' }
    | { type: 'italic' }
    | { type: 'code' }
    | { type: 'strikethrough' }
    | { type: 'link'; url: string }
    | { type: 'image'; src: string; alt?: string }

// Extract the type string from Span union
export type SpanType = Span['type']

// An open span is a span that started but hasn't closed yet.
// The full span info (like URL for links) is only available on close.
export type OpenSpan = {
    type: SpanType
    // UTF-16 offset from stream start where this span opened
    openOffset: number
}

// A closed span includes the full span data plus position info.
export type ClosedSpan = Span & {
    // UTF-16 offset from stream start
    offset: number
    // Length in UTF-16 code units
    length: number
}

// ============================================================================
// BLOCK TYPES
// ============================================================================

// Block types the parser recognizes.
export type BlockType =
    | 'paragraph'
    | 'heading'
    | 'code_block'
    | 'list_item'
    | 'table'
    | 'table_row'
    | 'table_header_cell'
    | 'table_cell'
    | 'blockquote'

// Block context for a chunk
export type BlockContext = {
    type: BlockType
    // For headings: 1-6
    level?: number
    // For code blocks: language identifier
    language?: string
    // For content inside a Markdown list item.
    list?: ListMetadata
    // For content inside a Markdown table cell.
    table?: TableMetadata
}

export type ListMetadata = {
    type: 'ordered' | 'unordered'
    depth: number
    marker: '-' | '+' | '*' | '.' | ')'
    ordinal?: number
    task?: { checked: boolean }
}

export type TableAlignment = 'left' | 'center' | 'right'

export type TableMetadata = {
    tableId: string
    rowIndex: number
    columnIndex: number
    cellId: string
    align?: TableAlignment
}

// ============================================================================
// CHUNK TYPE - Core output unit
// ============================================================================

// A chunk is a unit of parsed output. Chunks and spans are
// completely orthogonal — spans can start/end mid-chunk,
// multiple spans can exist in one chunk, etc.
export type Chunk = {
    // Plain text with formatting removed
    text: string

    // UTF-16 offset from stream start
    offset: number

    // Length in UTF-16 code units
    length: number

    // Block context this chunk belongs to
    block: BlockContext

    // Spans that opened in this chunk (will close in a future chunk)
    opening: OpenSpan[]

    // Spans that closed in this chunk (opened in a past chunk)
    closing: ClosedSpan[]

    // Spans fully contained within this chunk
    contained: ClosedSpan[]

    // If set, this chunk corrects previous output starting from this
    // UTF-16 offset. Consumer should discard everything from this
    // offset onwards and replace with this chunk + subsequent chunks.
    backtrackOffset?: number

    // Present when a configured recovery window prevented complete replay.
    recovery?: RecoveryInfo

    // Original markdown source (only if includeRawStreamedToken config is true).
    // Useful as fallback when parser messes up or for unsupported formats.
    original?: string
}

export type RecoveryInfo = {
    type: 'window_overflow'
    windowSize: number
    fullBacktrackOffset: number
    appliedBacktrackOffset: number
}

// Stream status wrapper for chunks.
export type StreamingChunk =
    | { status: 'STREAMING'; chunk: Chunk }
    | { status: 'START_STREAM' }
    | { status: 'END_STREAM' }

// ============================================================================
// PARSER CONFIGURATION
// ============================================================================

// Parser configuration options.
export type ParserConfig = {
    // Maximum characters the consumer can backtrack.
    // Default: undefined (unlimited backtracking).
    //
    // When corrections exceed this window:
    // - Best effort: fix what's within window
    // - Fall back to plain text if structure broken beyond repair
    windowSize?: number

    // Include original markdown source in chunk output.
    // Default: false (saves payload size).
    includeRawStreamedToken?: boolean
}

// ============================================================================
// INTERNAL TYPES - Used by parser internals
// ============================================================================

// Lookup map for tree-sitter ATX header marker node types to their heading levels.
// Used for both level extraction and marker-only content detection.
export const HEADER_MARKER_LEVELS: Record<string, number> = {
    'atx_h1_marker': 1,
    'atx_h2_marker': 2,
    'atx_h3_marker': 3,
    'atx_h4_marker': 4,
    'atx_h5_marker': 5,
    'atx_h6_marker': 6,
}

// Block types that are recognized by tree-sitter
export const BLOCK_TYPES = [
    'atx_heading', 'paragraph', 'fenced_code_block', 'list_item', 'blockquote',
    'pipe_table', 'pipe_table_header', 'pipe_table_row', 'pipe_table_cell'
] as const

// Syntax elements that should be suppressed (not emitted as content)
export const SUPPRESSED_SYNTAX_TYPES = [
    'list_marker_minus', 'list_marker_plus', 'list_marker_star',
    'list_marker_dot', 'list_marker_parenthesis',
    'task_list_marker_checked', 'task_list_marker_unchecked',
    '|'  // Table pipe delimiters
] as const

// Tracks the current block's state during parsing
export type BlockState = {
    type: string
    level?: number
    language?: string
    startIndex: number
    lastSegmentEnd: number
    hasEmittedContent?: boolean
}

// Information about a block type extracted from the AST
export type BlockInfo = {
    type: string
    level?: number
    language?: string
    list?: ListMetadata
    table?: TableMetadata
}

// Context passed to inline style extractors
export type InlineExtractionContext = {
    content: string
    node: Node
    startByte: number
    endByte: number
    baseSpans: OpenSpan[]
    blockInfo: BlockInfo
    inlineParser: Parser
    currentTree: Tree
}

// Configuration for a specific inline style type
export type InlineStyleConfig = {
    styleName: SpanType
    nodeType: string
    delimiterType: string
    minDelimiters: number
}

// Predefined inline style configurations
export const INLINE_STYLE_CONFIGS: Record<string, InlineStyleConfig> = {
    code: {
        styleName: 'code',
        nodeType: 'code_span',
        delimiterType: 'code_span_delimiter',
        minDelimiters: 2,
    },
    bold: {
        styleName: 'bold',
        nodeType: 'strong_emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,  // ** on each side = 4 delimiter nodes
    },
    italic: {
        styleName: 'italic',
        nodeType: 'emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 2,
    },
    strikethrough: {
        styleName: 'strikethrough',
        nodeType: 'strikethrough',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,  // ~~ on each side = 4 delimiter nodes
    },
    link: {
        styleName: 'link',
        nodeType: 'inline_link',
        delimiterType: '',
        minDelimiters: 0,
    },
    image: {
        styleName: 'image',
        nodeType: 'image',
        delimiterType: '',
        minDelimiters: 0,
    },
}

// ============================================================================
// SEGMENT GENERATOR STATE
// ============================================================================

// State maintained by the segment generator across chunks
export type SegmentGeneratorState = {
    // Total rendered UTF-16 code units emitted so far.
    totalUtf16Offset: number

    // Last rendered UTF-16 offset emitted to consumers.
    lastEmittedOffset: number

    // Raw markdown source UTF-16 offset processed so far.
    sourceOffset: number

    // Last raw markdown source UTF-16 offset that produced public output.
    lastEmittedSourceOffset: number

    // Currently open spans that haven't closed yet
    openSpans: OpenSpan[]

    // Current block being processed
    currentBlock: BlockState | null

    // Pending inline content waiting for delimiter closure
    pendingInlineContent: string

    // Start index for pending inline content
    pendingInlineStartIndex?: number

    // Accumulated content for backtrack reference
    accumulatedContent: string

    // Stable replay points used to translate source recovery ranges to rendered offsets.
    checkpoints: SegmentGeneratorCheckpoint[]
}

export type SegmentGeneratorCheckpoint = {
    sourceOffset: number
    renderedOffset: number
    lastEmittedSourceOffset: number
    lastEmittedOffset: number
    openSpans: OpenSpan[]
    currentBlock: BlockState | null
    pendingInlineContent: string
    pendingInlineStartIndex?: number
    accumulatedContent: string
}
