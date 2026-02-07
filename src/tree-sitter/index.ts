// Types and interfaces (type-only exports)
export type {
    StreamingSegment,
    StreamingChunk,
    BlockState,
    BlockInfo,
    InlineExtractionContext,
    InlineStyleConfig,
} from './types.js'

// Constants (runtime exports)
export {
    HEADER_MARKER_LEVELS,
    BLOCK_TYPES,
    SUPPRESSED_SYNTAX_TYPES,
    INLINE_STYLE_CONFIGS,
} from './types.js'

// Tree navigation
export {
    findActiveNodeAtPosition,
    findNodeInTree,
    findInlineNodeAtPosition,
    findBlockNode,
} from './tree-navigation.js'

// Block detection
export {
    getBlockInfo,
    isNewBlock,
    getHeadingLevel,
    getCodeBlockLanguage,
} from './block-detection.js'

// Inline detection
export {
    hasCompleteCodeSpanAt,
    hasCompleteBoldAt,
    hasCompleteItalicAt,
    hasCompleteStrikethroughAt,
    hasUnmatchedItalicMarker,
    isInsideCodeBlock,
    detectActiveStyles,
} from './inline-detection.js'

// Content extraction
export {
    getHeaderContent,
    getCodeBlockContent,
} from './content-extraction.js'

// Segment builder
export {
    createSegment,
    createStreamingChunk,
    createSegmentFromBlockInfo,
    createChunkFromBlockInfo,
    createPlainTextChunk,
    createCodeBlockChunk,
} from './segment-builder.js'

// Inline extractors
export {
    getInlineCodeSegments,
    getBoldSegments,
    getItalicSegments,
    getStrikethroughSegments,
} from './inline-extractors.js'

// Segment generator
export { generateSegments } from './segment-generator.js'
export type { SegmentGeneratorState, SegmentGeneratorContext } from './segment-generator.js'
