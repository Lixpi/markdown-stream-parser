import type { StreamingChunk, StreamingSegment, BlockInfo } from './types.js'

// Create a StreamingSegment with consistent defaults.
export function createSegment(
    segment: string,
    styles: string[],
    type: string,
    isBlockDefining: boolean,
    isProcessingNewLine: boolean,
    options?: {
        level?: number
        language?: string
        blockId?: number
    }
): StreamingSegment {
    const result: StreamingSegment = {
        segment,
        styles,
        type,
        isBlockDefining,
        isProcessingNewLine,
    }

    if (options?.level !== undefined) {
        result.level = options.level
    }
    if (options?.language !== undefined) {
        result.language = options.language
    }
    if (options?.blockId !== undefined) {
        result.blockId = options.blockId
    }

    return result
}

// Create a StreamingChunk with STREAMING status.
export function createStreamingChunk(segment: StreamingSegment): StreamingChunk {
    return {
        status: 'STREAMING',
        segment,
    }
}

// Create a segment from block info with common patterns.
export function createSegmentFromBlockInfo(
    text: string,
    styles: string[],
    blockInfo: BlockInfo,
    isBlockDefining: boolean,
    isProcessingNewLine: boolean
): StreamingSegment {
    return createSegment(
        text,
        styles,
        blockInfo.type,
        isBlockDefining,
        isProcessingNewLine,
        {
            level: blockInfo.level,
            language: blockInfo.language,
            blockId: blockInfo.id,
        }
    )
}

// Create a streaming chunk from block info.
export function createChunkFromBlockInfo(
    text: string,
    styles: string[],
    blockInfo: BlockInfo,
    isBlockDefining: boolean,
    isProcessingNewLine: boolean
): StreamingChunk {
    return createStreamingChunk(
        createSegmentFromBlockInfo(text, styles, blockInfo, isBlockDefining, isProcessingNewLine)
    )
}

// Create a plain text paragraph segment.
export function createPlainTextChunk(text: string, isBlockDefining: boolean = false): StreamingChunk {
    return createStreamingChunk({
        segment: text,
        styles: [],
        type: 'paragraph',
        isBlockDefining,
        isProcessingNewLine: text.includes('\n'),
    })
}

// Create a code block segment.
export function createCodeBlockChunk(
    text: string,
    language: string = '',
    isBlockDefining: boolean = false
): StreamingChunk {
    return createStreamingChunk({
        segment: text,
        styles: [],
        type: 'codeBlock',
        isBlockDefining,
        isProcessingNewLine: text.includes('\n'),
        language,
    })
}
