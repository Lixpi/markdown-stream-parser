import type { Parser } from 'web-tree-sitter'

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
    '|'  // Table pipe delimiters
] as const

// Represents a parsed segment of streaming markdown content
export type StreamingSegment = {
    level?: number
    language?: string
    segment: string
    styles: string[]
    type: string
    isBlockDefining: boolean
    isProcessingNewLine: boolean
    blockId?: number
}

// A chunk of streaming data with status information
export type StreamingChunk = {
    status: string
    segment?: StreamingSegment
}

// Tracks the current block's state during parsing
export type BlockState = {
    type: string
    level?: number
    language?: string
    startIndex: number
    lastSegmentEnd: number
    styles: Set<string>
    hasEmittedContent?: boolean
}

// Information about a block type extracted from the AST
export type BlockInfo = {
    type: string
    level?: number
    language?: string
    id?: number
}

// Context passed to inline style extractors
export type InlineExtractionContext = {
    content: string
    node: Parser.SyntaxNode
    startByte: number
    endByte: number
    baseStyles: string[]
    blockInfo: BlockInfo
    inlineParser: Parser
    currentTree: Parser.Tree
}

// Configuration for a specific inline style type
export type InlineStyleConfig = {
    styleName: string
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
}
