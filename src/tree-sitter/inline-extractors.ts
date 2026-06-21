import type { Parser, Tree, Node } from 'web-tree-sitter'
import type { StreamingChunk, BlockInfo, InlineStyleConfig, SpanType, ClosedSpan } from './types.js'
import { findInlineNodeAtPosition } from './tree-navigation.js'
import { createChunkFromBlockInfo, createClosedSpan, byteOffsetToUtf16 } from './segment-builder.js'

// NOTE: These legacy extractors are kept for backward compatibility but are
// no longer used by the main segment generator. The new API uses processInlineSpans()
// in segment-generator.ts which handles spans using the opening/closing/contained model.
//
// These functions will be deprecated in a future version.

// Generic inline style segment extractor.
// Extracts segments with proper prefix/content/suffix handling for any inline style.
// DEPRECATED: Use processInlineSpans() in segment-generator.ts instead.
function extractInlineStyleSegments(
    config: InlineStyleConfig,
    startByte: number,
    endByte: number,
    blockInfo: BlockInfo,
    currentTree: Tree,
    inlineParser: Parser,
    currentUtf16Offset: number = 0,
    useDescendants: boolean = false
): StreamingChunk[] {
    const segments: StreamingChunk[] = []

    const inlineNode = findInlineNodeAtPosition(currentTree.rootNode, startByte)

    // Check for both 'inline' and 'pipe_table_cell'
    if (!inlineNode || (inlineNode.type !== 'inline' && inlineNode.type !== 'pipe_table_cell')) {
        throw new Error(`Tree-sitter inline node required for ${config.styleName} segment extraction`)
    }

    const inlineContent = inlineNode.text
    const inlineTree = inlineParser.parse(inlineContent)

    const relativeStart = startByte - inlineNode.startIndex
    const relativeEnd = endByte - inlineNode.startIndex

    const styleNodes = inlineTree.rootNode.descendantsOfType(config.nodeType)
    let offset = currentUtf16Offset

    // Check if any style node actually overlaps with our range
    for (const styleNode of styleNodes) {
        // Check overlap
        if (styleNode.startIndex < relativeEnd && styleNode.endIndex > relativeStart) {
            // Get delimiters - either children or descendants based on config
            let delimiters: Node[]
            if (useDescendants) {
                delimiters = styleNode.descendantsOfType(config.delimiterType)
                    .sort((a: Node, b: Node) => a.startIndex - b.startIndex)
            } else {
                delimiters = styleNode.children.filter((c: Node) => c.type === config.delimiterType)
            }

            if (delimiters.length >= config.minDelimiters) {
                // Calculate content boundaries based on delimiter positions
                let openingEnd: number
                let closingStart: number

                if (config.minDelimiters === 2) {
                    // Simple case: single delimiter on each side (inline code, italic)
                    openingEnd = delimiters[0].endIndex
                    closingStart = delimiters[delimiters.length - 1].startIndex
                } else {
                    // Complex case: multiple delimiter characters (bold **, strikethrough ~~)
                    openingEnd = delimiters[1].endIndex
                    closingStart = delimiters[delimiters.length - 2].startIndex
                }

                // 1. Prefix (Text before style span)
                if (styleNode.startIndex > relativeStart) {
                    const intersectionStart = Math.max(0, relativeStart)
                    const intersectionEnd = Math.min(styleNode.startIndex, relativeEnd)

                    if (intersectionStart < intersectionEnd) {
                        const prefixText = inlineContent.substring(intersectionStart, intersectionEnd)
                        if (prefixText) {
                            segments.push(createChunkFromBlockInfo(prefixText, offset, blockInfo))
                            offset += prefixText.length
                        }
                    }
                }

                // 2. Styled Content (without markers)
                const contentOverlapStart = Math.max(openingEnd, relativeStart)
                const contentOverlapEnd = Math.min(closingStart, relativeEnd)

                if (contentOverlapStart < contentOverlapEnd) {
                    const styledText = inlineContent.substring(contentOverlapStart, contentOverlapEnd)
                    if (styledText) {
                        // Create a contained span for this style
                        const spanType = config.styleName as 'bold' | 'italic' | 'code' | 'strikethrough'
                        const containedSpan: ClosedSpan = createClosedSpan(spanType, offset, styledText.length)

                        segments.push(createChunkFromBlockInfo(styledText, offset, blockInfo, {
                            contained: [containedSpan]
                        }))
                        offset += styledText.length
                    }
                }

                // 3. Suffix (Text after style span)
                if (styleNode.endIndex < relativeEnd) {
                    const suffixStart = Math.max(styleNode.endIndex, relativeStart)
                    const suffixEnd = relativeEnd

                    if (suffixStart < suffixEnd) {
                        const suffixText = inlineContent.substring(suffixStart, suffixEnd)
                        if (suffixText) {
                            segments.push(createChunkFromBlockInfo(suffixText, offset, blockInfo))
                            offset += suffixText.length
                        }
                    }
                }

                return segments
            }
        }
    }

    throw new Error(`Tree-sitter inline node required for ${config.styleName} segment extraction`)
}

// Extract inline code segments, stripping backtick delimiters.
// DEPRECATED: Use processInlineSpans() in segment-generator.ts instead.
export function getInlineCodeSegments(
    content: string,
    node: Node,
    startByte: number,
    endByte: number,
    blockInfo: BlockInfo,
    currentTree: Tree,
    inlineParser: Parser,
    currentUtf16Offset: number = 0
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'code',
        nodeType: 'code_span',
        delimiterType: 'code_span_delimiter',
        minDelimiters: 2,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, blockInfo,
        currentTree, inlineParser, currentUtf16Offset, false
    )
}

// Extract bold segments, stripping ** delimiters.
// DEPRECATED: Use processInlineSpans() in segment-generator.ts instead.
export function getBoldSegments(
    content: string,
    node: Node,
    startByte: number,
    endByte: number,
    blockInfo: BlockInfo,
    currentTree: Tree,
    inlineParser: Parser,
    currentUtf16Offset: number = 0
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'bold',
        nodeType: 'strong_emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, blockInfo,
        currentTree, inlineParser, currentUtf16Offset, false
    )
}

// Extract italic segments, stripping * or _ delimiters.
// DEPRECATED: Use processInlineSpans() in segment-generator.ts instead.
export function getItalicSegments(
    content: string,
    node: Node,
    startByte: number,
    endByte: number,
    blockInfo: BlockInfo,
    currentTree: Tree,
    inlineParser: Parser,
    currentUtf16Offset: number = 0
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'italic',
        nodeType: 'emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 2,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, blockInfo,
        currentTree, inlineParser, currentUtf16Offset, false
    )
}

// Extract strikethrough segments, stripping ~~ delimiters.
// DEPRECATED: Use processInlineSpans() in segment-generator.ts instead.
export function getStrikethroughSegments(
    content: string,
    node: Node,
    startByte: number,
    endByte: number,
    blockInfo: BlockInfo,
    currentTree: Tree,
    inlineParser: Parser,
    currentUtf16Offset: number = 0
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'strikethrough',
        nodeType: 'strikethrough',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,
    }

    // Strikethrough uses descendants for delimiters (they can be nested)
    return extractInlineStyleSegments(
        config, startByte, endByte, blockInfo,
        currentTree, inlineParser, currentUtf16Offset, true
    )
}
