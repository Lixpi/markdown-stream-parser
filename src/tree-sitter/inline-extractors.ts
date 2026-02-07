import type { Parser } from 'web-tree-sitter'
import type { StreamingChunk, BlockInfo, InlineStyleConfig, INLINE_STYLE_CONFIGS } from './types.js'
import { findInlineNodeAtPosition } from './tree-navigation.js'
import { createChunkFromBlockInfo } from './segment-builder.js'

// Generic inline style segment extractor.
// Extracts segments with proper prefix/content/suffix handling for any inline style.
function extractInlineStyleSegments(
    config: InlineStyleConfig,
    startByte: number,
    endByte: number,
    baseStyles: string[],
    blockInfo: BlockInfo,
    currentTree: Parser.Tree,
    inlineParser: Parser,
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

    // Check if any style node actually overlaps with our range
    for (const styleNode of styleNodes) {
        // Check overlap
        if (styleNode.startIndex < relativeEnd && styleNode.endIndex > relativeStart) {
            // Get delimiters - either children or descendants based on config
            let delimiters: Parser.SyntaxNode[]
            if (useDescendants) {
                delimiters = styleNode.descendantsOfType(config.delimiterType)
                    .sort((a: Parser.SyntaxNode, b: Parser.SyntaxNode) => a.startIndex - b.startIndex)
            } else {
                delimiters = styleNode.children.filter((c: Parser.SyntaxNode) => c.type === config.delimiterType)
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
                            segments.push(createChunkFromBlockInfo(
                                prefixText,
                                baseStyles.filter(s => s !== config.styleName),
                                blockInfo,
                                false,
                                prefixText.includes('\n')
                            ))
                        }
                    }
                }

                // 2. Styled Content (without markers)
                const contentOverlapStart = Math.max(openingEnd, relativeStart)
                const contentOverlapEnd = Math.min(closingStart, relativeEnd)

                if (contentOverlapStart < contentOverlapEnd) {
                    const styledText = inlineContent.substring(contentOverlapStart, contentOverlapEnd)
                    if (styledText) {
                        // Ensure the style is present
                        const styledStyles = [...baseStyles]
                        if (styledStyles.indexOf(config.styleName) === -1) {
                            styledStyles.push(config.styleName)
                        }

                        segments.push(createChunkFromBlockInfo(
                            styledText,
                            styledStyles,
                            blockInfo,
                            false,
                            styledText.includes('\n')
                        ))
                    }
                }

                // 3. Suffix (Text after style span)
                if (styleNode.endIndex < relativeEnd) {
                    const suffixStart = Math.max(styleNode.endIndex, relativeStart)
                    const suffixEnd = relativeEnd

                    if (suffixStart < suffixEnd) {
                        const suffixText = inlineContent.substring(suffixStart, suffixEnd)
                        if (suffixText) {
                            segments.push(createChunkFromBlockInfo(
                                suffixText,
                                baseStyles.filter(s => s !== config.styleName),
                                blockInfo,
                                false,
                                suffixText.includes('\n')
                            ))
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
export function getInlineCodeSegments(
    content: string,
    node: Parser.SyntaxNode,
    startByte: number,
    endByte: number,
    baseStyles: string[],
    blockInfo: BlockInfo,
    currentTree: Parser.Tree,
    inlineParser: Parser
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'code',
        nodeType: 'code_span',
        delimiterType: 'code_span_delimiter',
        minDelimiters: 2,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, baseStyles, blockInfo,
        currentTree, inlineParser, false
    )
}

// Extract bold segments, stripping ** delimiters.
export function getBoldSegments(
    content: string,
    node: Parser.SyntaxNode,
    startByte: number,
    endByte: number,
    baseStyles: string[],
    blockInfo: BlockInfo,
    currentTree: Parser.Tree,
    inlineParser: Parser
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'bold',
        nodeType: 'strong_emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, baseStyles, blockInfo,
        currentTree, inlineParser, false
    )
}

// Extract italic segments, stripping * or _ delimiters.
export function getItalicSegments(
    content: string,
    node: Parser.SyntaxNode,
    startByte: number,
    endByte: number,
    baseStyles: string[],
    blockInfo: BlockInfo,
    currentTree: Parser.Tree,
    inlineParser: Parser
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'italic',
        nodeType: 'emphasis',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 2,
    }

    return extractInlineStyleSegments(
        config, startByte, endByte, baseStyles, blockInfo,
        currentTree, inlineParser, false
    )
}

// Extract strikethrough segments, stripping ~~ delimiters.
export function getStrikethroughSegments(
    content: string,
    node: Parser.SyntaxNode,
    startByte: number,
    endByte: number,
    baseStyles: string[],
    blockInfo: BlockInfo,
    currentTree: Parser.Tree,
    inlineParser: Parser
): StreamingChunk[] {
    const config: InlineStyleConfig = {
        styleName: 'strikethrough',
        nodeType: 'strikethrough',
        delimiterType: 'emphasis_delimiter',
        minDelimiters: 4,
    }

    // Strikethrough uses descendants for delimiters (they can be nested)
    return extractInlineStyleSegments(
        config, startByte, endByte, baseStyles, blockInfo,
        currentTree, inlineParser, true
    )
}
