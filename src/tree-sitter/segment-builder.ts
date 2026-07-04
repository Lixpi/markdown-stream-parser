import type {
    StreamingChunk,
    Chunk,
    BlockInfo,
    BlockContext,
    BlockType,
    OpenSpan,
    ClosedSpan,
    RecoveryInfo,
    ParserConfig
} from './types.ts'

// ============================================================================
// UTF-16 OFFSET UTILITIES
// ============================================================================

// Convert byte offset to UTF-16 code unit offset.
// Tree-sitter gives us byte positions, but JavaScript strings use UTF-16.
export function byteOffsetToUtf16(text: string, byteOffset: number): number {
    const encoder = new TextEncoder()
    let utf16Offset = 0
    let currentByteOffset = 0

    for (const char of text) {
        if (currentByteOffset >= byteOffset) break
        const charBytes = encoder.encode(char).length
        currentByteOffset += charBytes
        // Each JS string char is 1 UTF-16 code unit, except surrogates (2)
        utf16Offset += char.length // .length gives UTF-16 code units
    }

    return utf16Offset
}

// Convert UTF-16 offset to byte offset.
// Needed when we have UTF-16 positions and need tree-sitter byte positions.
export function utf16ToByteOffset(text: string, utf16Offset: number): number {
    const encoder = new TextEncoder()
    let currentUtf16 = 0
    let byteOffset = 0

    for (const char of text) {
        if (currentUtf16 >= utf16Offset) break
        const charBytes = encoder.encode(char).length
        byteOffset += charBytes
        currentUtf16 += char.length
    }

    return byteOffset
}

// ============================================================================
// BLOCK CONTEXT HELPERS
// ============================================================================

// Map internal block type strings to BlockType enum.
export function mapBlockType(type: string): BlockType {
    switch (type) {
        case 'header':
        case 'atx_heading':
            return 'heading'
        case 'codeBlock':
        case 'fenced_code_block':
            return 'code_block'
        case 'list_item':
            return 'list_item'
        case 'pipe_table':
        case 'table':
            return 'table'
        case 'pipe_table_row':
            return 'table_row'
        case 'table_header_cell':
            return 'table_header_cell'
        case 'pipe_table_cell':
        case 'table_cell':
            return 'table_cell'
        case 'blockquote':
            return 'blockquote'
        case 'paragraph':
        default:
            return 'paragraph'
    }
}

// Create a BlockContext from BlockInfo.
export function createBlockContext(blockInfo: BlockInfo): BlockContext {
    const context: BlockContext = {
        type: mapBlockType(blockInfo.type)
    }

    if (blockInfo.level !== undefined) {
        context.level = blockInfo.level
    }
    if (blockInfo.language !== undefined) {
        context.language = blockInfo.language
    }
    if (blockInfo.list !== undefined) {
        context.list = blockInfo.list
    }
    if (blockInfo.table !== undefined) {
        context.table = blockInfo.table
    }

    return context
}

// ============================================================================
// CHUNK BUILDERS
// ============================================================================

// Create a new Chunk with the new API format.
export function createChunk(
    text: string,
    offset: number,
    block: BlockContext,
    options?: {
        opening?: OpenSpan[]
        closing?: ClosedSpan[]
        contained?: ClosedSpan[]
        backtrackOffset?: number
        recovery?: RecoveryInfo
        original?: string
    }
): Chunk {
    return {
        text,
        offset,
        length: text.length,
        block,
        opening: options?.opening ?? [],
        closing: options?.closing ?? [],
        contained: options?.contained ?? [],
        backtrackOffset: options?.backtrackOffset,
        recovery: options?.recovery,
        original: options?.original,
    }
}

// Create a StreamingChunk wrapper for a Chunk.
export function createStreamingChunkWrapper(chunk: Chunk): StreamingChunk {
    return {
        status: 'STREAMING',
        chunk,
    }
}

// Create a streaming chunk from block info.
export function createChunkFromBlockInfo(
    text: string,
    offset: number,
    blockInfo: BlockInfo,
    options?: {
        opening?: OpenSpan[]
        closing?: ClosedSpan[]
        contained?: ClosedSpan[]
        backtrackOffset?: number
        recovery?: RecoveryInfo
        original?: string
    }
): StreamingChunk {
    const chunk = createChunk(text, offset, createBlockContext(blockInfo), options)
    return createStreamingChunkWrapper(chunk)
}

// Create a plain text paragraph chunk.
export function createPlainTextChunk(
    text: string,
    offset: number,
    options?: {
        opening?: OpenSpan[]
        closing?: ClosedSpan[]
        contained?: ClosedSpan[]
        original?: string
    }
): StreamingChunk {
    return createStreamingChunkWrapper(
        createChunk(text, offset, { type: 'paragraph' }, options)
    )
}

// Create a code block chunk.
export function createCodeBlockChunk(
    text: string,
    offset: number,
    language: string = '',
    options?: {
        opening?: OpenSpan[]
        closing?: ClosedSpan[]
        contained?: ClosedSpan[]
        original?: string
    }
): StreamingChunk {
    return createStreamingChunkWrapper(
        createChunk(text, offset, { type: 'code_block', language }, options)
    )
}

// Create a heading chunk.
export function createHeadingChunk(
    text: string,
    offset: number,
    level: number,
    options?: {
        opening?: OpenSpan[]
        closing?: ClosedSpan[]
        contained?: ClosedSpan[]
        original?: string
    }
): StreamingChunk {
    return createStreamingChunkWrapper(
        createChunk(text, offset, { type: 'heading', level }, options)
    )
}

// ============================================================================
// SPAN BUILDERS
// ============================================================================

// Create an OpenSpan.
export function createOpenSpan(type: OpenSpan['type'], openOffset: number): OpenSpan {
    return { type, openOffset }
}

// Create a ClosedSpan for basic styles (bold, italic, code, strikethrough).
export function createClosedSpan(
    type: 'bold' | 'italic' | 'code' | 'strikethrough',
    offset: number,
    length: number
): ClosedSpan {
    return { type, offset, length }
}

// Create a ClosedSpan for a link.
export function createLinkSpan(
    offset: number,
    length: number,
    url: string
): ClosedSpan {
    return { type: 'link', offset, length, url }
}

// Create a ClosedSpan for an image.
export function createImageSpan(
    offset: number,
    length: number,
    src: string,
    alt?: string
): ClosedSpan {
    return { type: 'image', offset, length, src, alt }
}
