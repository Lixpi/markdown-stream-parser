import type { Parser } from 'web-tree-sitter'
import type {
    StreamingChunk,
    BlockInfo,
    SegmentGeneratorState,
    OpenSpan,
    ClosedSpan,
    SpanType,
    ParserConfig
} from './types.js'
import { findActiveNodeAtPosition, findInlineNodeAtPosition, findBlockNode } from './tree-navigation.js'
import { getBlockInfo, isNewBlock } from './block-detection.js'
import {
    hasCompleteCodeSpanAt,
    hasCompleteBoldAt,
    hasCompleteItalicAt,
    hasCompleteStrikethroughAt,
    hasCompleteLinkAt,
    hasCompleteImageAt,
    hasIncompleteLinkOpening,
    hasIncompleteImageOpening,
    hasUnmatchedItalicMarker,
    isInsideCodeBlock,
    detectActiveStyles
} from './inline-detection.js'
import { getHeaderContent, getCodeBlockContent, getInlineContent } from './content-extraction.js'
import {
    createChunkFromBlockInfo,
    createPlainTextChunk,
    createCodeBlockChunk,
    createHeadingChunk,

    createOpenSpan,
    createClosedSpan,
    createLinkSpan,
    createImageSpan,
    createBlockContext
} from './segment-builder.js'

// Re-import the constant that we need locally
const HEADER_MARKER_LEVELS_LOCAL: Record<string, number> = {
    'atx_h1_marker': 1,
    'atx_h2_marker': 2,
    'atx_h3_marker': 3,
    'atx_h4_marker': 4,
    'atx_h5_marker': 5,
    'atx_h6_marker': 6,
}

const SUPPRESSED_SYNTAX_TYPES_LOCAL = [
    'list_marker_minus', 'list_marker_plus', 'list_marker_star',
    'list_marker_dot', 'list_marker_parenthesis',
    '|'  // Table pipe delimiters
]

export type SegmentGeneratorContext = {
    content: string
    currentTree: Parser.Tree
    inlineParser: Parser | null
    state: SegmentGeneratorState
    config?: ParserConfig
}

// Create initial segment generator state
export function createInitialState(): SegmentGeneratorState {
    return {
        totalUtf16Offset: 0,
        lastEmittedOffset: 0,
        openSpans: [],
        currentBlock: null,
        pendingInlineContent: '',
        accumulatedContent: ''
    }
}

// Detect span type from tree-sitter node type
function detectSpanType(nodeType: string): SpanType | null {
    switch (nodeType) {
        case 'strong_emphasis': return 'bold'
        case 'emphasis': return 'italic'
        case 'code_span': return 'code'
        case 'strikethrough': return 'strikethrough'
        case 'inline_link': return 'link'
        case 'image': return 'image'
        default: return null
    }
}

// Extract span metadata (URL for links, src/alt for images)
function extractSpanMetadata(node: Parser.SyntaxNode): { url?: string; src?: string; alt?: string } {
    if (node.type === 'inline_link') {
        const destNode = node.descendantsOfType('link_destination')[0]
        return { url: destNode?.text ?? '' }
    }
    if (node.type === 'image') {
        const destNode = node.descendantsOfType('link_destination')[0]
        const descNode = node.descendantsOfType('image_description')[0]
        return {
            src: destNode?.text ?? '',
            alt: descNode?.text
        }
    }
    return {}
}

// Check if span is fully contained within chunk boundaries
function isSpanContained(spanStart: number, spanEnd: number, chunkStart: number, chunkEnd: number): boolean {
    return spanStart >= chunkStart && spanEnd <= chunkEnd
}

// Check if span opens in this chunk but closes later
function isSpanOpening(spanStart: number, spanEnd: number, chunkStart: number, chunkEnd: number): boolean {
    return spanStart >= chunkStart && spanStart < chunkEnd && spanEnd > chunkEnd
}

// Check if span opened earlier and closes in this chunk
function isSpanClosing(spanStart: number, spanEnd: number, chunkStart: number, chunkEnd: number): boolean {
    return spanStart < chunkStart && spanEnd >= chunkStart && spanEnd <= chunkEnd
}

// Create a closed span from node metadata
function createClosedSpanFromNode(
    spanType: SpanType,
    node: Parser.SyntaxNode,
    offset: number,
    length: number
): ClosedSpan | null {
    const metadata = extractSpanMetadata(node)

    if (spanType === 'link' && metadata.url !== undefined) {
        return createLinkSpan(offset, length, metadata.url)
    }
    if (spanType === 'image' && metadata.src !== undefined) {
        return createImageSpan(offset, length, metadata.src, metadata.alt)
    }
    if (spanType === 'bold' || spanType === 'italic' || spanType === 'code' || spanType === 'strikethrough') {
        return createClosedSpan(spanType, offset, length)
    }
    return null
}

// Process a single style node and categorize it
function categorizeSpanNode(
    node: Parser.SyntaxNode,
    content: string,
    chunkStartUtf16: number,
    chunkEndUtf16: number,
    openSpans: OpenSpan[]
): {
    contained?: ClosedSpan
    opening?: OpenSpan
    closing?: ClosedSpan
    closedOpenIndex?: number
} {
    const spanType = detectSpanType(node.type)
    if (!spanType) return {}

    // node.startIndex/endIndex are already UTF-16 character offsets in web-tree-sitter JS bindings
    const spanStartUtf16 = node.startIndex
    const spanEndUtf16 = node.endIndex
    const spanLength = spanEndUtf16 - spanStartUtf16

    // Fully contained
    if (isSpanContained(spanStartUtf16, spanEndUtf16, chunkStartUtf16, chunkEndUtf16)) {
        const span = createClosedSpanFromNode(spanType, node, spanStartUtf16, spanLength)
        return span ? { contained: span } : {}
    }

    // Opens here, closes later
    if (isSpanOpening(spanStartUtf16, spanEndUtf16, chunkStartUtf16, chunkEndUtf16)) {
        return { opening: createOpenSpan(spanType, spanStartUtf16) }
    }

    // Opened earlier, closes here
    if (isSpanClosing(spanStartUtf16, spanEndUtf16, chunkStartUtf16, chunkEndUtf16)) {
        const matchingIdx = openSpans.findIndex(s => s.type === spanType)
        if (matchingIdx !== -1) {
            const matchingOpen = openSpans[matchingIdx]
            const totalLength = spanEndUtf16 - matchingOpen.openOffset
            const span = createClosedSpanFromNode(spanType, node, matchingOpen.openOffset, totalLength)
            return span ? { closing: span, closedOpenIndex: matchingIdx } : {}
        }
    }

    return {}
}

// Process inline styles and categorize them as opening/closing/contained
function processInlineSpans(
    inlineTree: Parser.Tree,
    chunkStartUtf16: number,
    chunkEndUtf16: number,
    content: string,
    state: SegmentGeneratorState
): { opening: OpenSpan[]; closing: ClosedSpan[]; contained: ClosedSpan[]; newOpenSpans: OpenSpan[] } {
    const opening: OpenSpan[] = []
    const closing: ClosedSpan[] = []
    const contained: ClosedSpan[] = []
    const newOpenSpans = [...state.openSpans]
    const indicesToRemove: number[] = []

    const styleNodeTypes = ['code_span', 'strong_emphasis', 'emphasis', 'strikethrough', 'inline_link', 'image']

    for (const nodeType of styleNodeTypes) {
        const nodes = inlineTree.rootNode.descendantsOfType(nodeType)

        for (const node of nodes) {
            const result = categorizeSpanNode(node, content, chunkStartUtf16, chunkEndUtf16, newOpenSpans)

            if (result.contained) {
                contained.push(result.contained)
            }
            if (result.opening) {
                opening.push(result.opening)
                newOpenSpans.push(result.opening)
            }
            if (result.closing) {
                closing.push(result.closing)
                if (result.closedOpenIndex !== undefined) {
                    indicesToRemove.push(result.closedOpenIndex)
                }
            }
        }
    }

    // Remove closed spans from open list (in reverse order to preserve indices)
    indicesToRemove.sort((a, b) => b - a)
    for (const idx of indicesToRemove) {
        newOpenSpans.splice(idx, 1)
    }

    return { opening, closing, contained, newOpenSpans }
}

// Generate chunks for a range of content using the new orthogonal chunks/spans model.
// Chunks represent text segments; spans represent inline styles that may cross chunk boundaries.
export function generateSegments(
    fromIndex: number,
    toIndex: number,
    context: SegmentGeneratorContext
): { segments: StreamingChunk[]; state: SegmentGeneratorState } {
    const { content, currentTree, inlineParser, config } = context
    let state = { ...context.state }

    if (!currentTree) {
        return { segments: [], state }
    }

    const segments: StreamingChunk[] = []
    let newContent = content.substring(fromIndex, toIndex)
    let actualFromIndex = fromIndex
    let actualToIndex = toIndex

    // Check if we have pending inline content from previous incomplete structure
    if (state.pendingInlineContent) {
        // Prepend pending content
        newContent = state.pendingInlineContent + newContent
        actualFromIndex = state.pendingInlineStartIndex ?? fromIndex
        state = { ...state, pendingInlineContent: '' }
    }

    // Calculate UTF-16 offsets for this chunk
    const chunkStartUtf16 = state.totalUtf16Offset
    const chunkTextUtf16Length = newContent.length
    const chunkEndUtf16 = chunkStartUtf16 + chunkTextUtf16Length

    // Check if current content has unmatched inline delimiters
    const inlineNode = findInlineNodeAtPosition(currentTree.rootNode, actualFromIndex)
    if (inlineNode && inlineParser) {
        const inlineContent = inlineNode.text
        const inlineTree = inlineParser.parse(inlineContent)

        // Count the range in the new portion
        const newPortionStart = actualFromIndex - inlineNode.startIndex
        const newPortionEnd = actualToIndex - inlineNode.startIndex
        const newPortion = inlineContent.substring(Math.max(0, newPortionStart), newPortionEnd)

        // Check for unmatched backtick
        if (newPortion.includes('`')) {
            const hasCompleteCodeSpan = hasCompleteCodeSpanAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteCodeSpan) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                return { segments, state }
            }
        }

        // Check for unmatched bold markers
        if (newPortion.includes('**')) {
            const hasCompleteBold = hasCompleteBoldAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteBold) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                return { segments, state }
            }
        }

        // Check for unmatched italic markers (skip if inside code block)
        const insideCodeBlock = isInsideCodeBlock(currentTree.rootNode, actualFromIndex, currentTree, inlineParser)
        if (!insideCodeBlock) {
            const hasUnmatchedItalic = hasUnmatchedItalicMarker(newPortion, inlineParser)
            if (hasUnmatchedItalic) {
                const hasCompleteItalic = hasCompleteItalicAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
                if (!hasCompleteItalic) {
                    state.pendingInlineContent = newContent
                    state.pendingInlineStartIndex = actualFromIndex
                    return { segments, state }
                }
            }
        }

        // Check for unmatched strikethrough markers
        if (newPortion.includes('~~')) {
            const hasCompleteStrikethrough = hasCompleteStrikethroughAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteStrikethrough) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                return { segments, state }
            }
        }

        // Check for incomplete link opening [
        if (newPortion.includes('[')) {
            const hasCompleteLink = hasCompleteLinkAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteLink && hasIncompleteLinkOpening(newPortion, inlineParser)) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                return { segments, state }
            }
        }

        // Check for incomplete image opening ![
        if (newPortion.includes('![')) {
            const hasCompleteImage = hasCompleteImageAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteImage && hasIncompleteImageOpening(newPortion, inlineParser)) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                return { segments, state }
            }
        }
    }

    // Skip empty content
    if (!newContent) {
        return { segments, state }
    }

    // Find the deepest node containing the new content position
    const nodeAtPosition = findActiveNodeAtPosition(currentTree.rootNode, actualFromIndex)

    if (!nodeAtPosition) {
        // If no node found, treat as plain text with current offset
        const chunk = createPlainTextChunk(newContent, chunkStartUtf16, {
            original: config?.includeRawStreamedToken ? newContent : undefined
        })
        state = {
            ...state,
            totalUtf16Offset: chunkEndUtf16,
            lastEmittedOffset: chunkEndUtf16,
            accumulatedContent: state.accumulatedContent + newContent
        }
        return { segments: [chunk], state }
    }

    // Check if the node is a suppressed syntax type
    if (SUPPRESSED_SYNTAX_TYPES_LOCAL.indexOf(nodeAtPosition.type) !== -1) {
        // Update offset but don't emit
        state = { ...state, totalUtf16Offset: chunkEndUtf16 }
        return { segments, state }
    }

    // Check if we're inside a table delimiter row
    let currentForDelimiter: Parser.SyntaxNode | null = nodeAtPosition
    while (currentForDelimiter) {
        if (currentForDelimiter.type === 'pipe_table_delimiter_row' ||
            currentForDelimiter.type === 'pipe_table_delimiter_cell') {
            state = { ...state, totalUtf16Offset: chunkEndUtf16 }
            return { segments, state }
        }
        currentForDelimiter = currentForDelimiter.parent
    }

    // Determine the block type and properties
    const blockInfo = getBlockInfo(nodeAtPosition)

    // Process content based on block type
    let processedContent = newContent

    if (blockInfo.type === 'header') {
        const blockNode = findBlockNode(nodeAtPosition)
        try {
            processedContent = getHeaderContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex)
        } catch (e) {
            console.warn('[PARSER] Failed to extract header content, using raw:', e)
            processedContent = newContent
        }

        // Don't emit if it's only markers
        if (processedContent.length === 0 || processedContent.trim().length === 0) {
            state = { ...state, totalUtf16Offset: chunkEndUtf16 }
            return { segments, state }
        }
    } else if (blockInfo.type === 'codeBlock') {
        const blockNode = findBlockNode(nodeAtPosition)
        try {
            processedContent = getCodeBlockContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex)
        } catch (e) {
            console.warn('[PARSER] Failed to extract code block content, using raw:', e)
            processedContent = newContent
        }

        if (processedContent.length === 0) {
            state = { ...state, totalUtf16Offset: chunkEndUtf16 }
            return { segments, state }
        }
    } else if (blockInfo.type === 'paragraph') {
        // Handle incomplete header markers
        if (nodeAtPosition.type in HEADER_MARKER_LEVELS_LOCAL) {
            return { segments, state }
        }

        // Handle code fence detection in paragraph content
        const result = handleCodeFenceInParagraph(
            newContent, actualFromIndex, actualToIndex, content,
            segments, chunkStartUtf16, config
        )
        if (result.handled) {
            state = {
                ...state,
                totalUtf16Offset: state.totalUtf16Offset + result.utf16Consumed,
                lastEmittedOffset: state.totalUtf16Offset + result.utf16Consumed,
                accumulatedContent: state.accumulatedContent + newContent
            }
            return { segments: result.segments, state }
        }
    }

    // Process inline spans for non-codeBlock types
    let opening: OpenSpan[] = []
    let closing: ClosedSpan[] = []
    let contained: ClosedSpan[] = []
    let strippedContent = processedContent

    if (blockInfo.type !== 'codeBlock' && inlineParser) {
        const fullContent = state.accumulatedContent + processedContent
        const inlineTree = inlineParser.parse(fullContent)

        // The chunk boundaries in the ACCUMULATED content space
        const accumulatedOffset = state.accumulatedContent.length
        const chunkStartInAccumulated = accumulatedOffset
        const chunkEndInAccumulated = accumulatedOffset + processedContent.length

        const spanResult = processInlineSpans(
            inlineTree,
            chunkStartInAccumulated,  // Use position in accumulated content
            chunkEndInAccumulated,
            fullContent,
            state
        )
        opening = spanResult.opening
        closing = spanResult.closing
        contained = spanResult.contained
        state = { ...state, openSpans: spanResult.newOpenSpans }

        // Strip inline markers from the content
        strippedContent = getInlineContent(
            processedContent,
            inlineParser.parse(processedContent),  // Parse just the new content
            0,
            processedContent.length
        )
    }

    // Create the chunk with the new API
    const chunk = createChunkFromBlockInfo(
        strippedContent,
        chunkStartUtf16,
        blockInfo,
        {
            opening,
            closing,
            contained,
            original: config?.includeRawStreamedToken ? newContent : undefined
        }
    )
    segments.push(chunk)

    // Update state
    state = {
        ...state,
        totalUtf16Offset: chunkStartUtf16 + processedContent.length,
        lastEmittedOffset: chunkStartUtf16 + processedContent.length,
        accumulatedContent: state.accumulatedContent + newContent,
        currentBlock: {
            type: blockInfo.type,
            level: blockInfo.level,
            language: blockInfo.language,
            startIndex: nodeAtPosition.startIndex,
            lastSegmentEnd: actualToIndex,
            hasEmittedContent: true
        }
    }

    return { segments, state }
}

// Handle code fence detection when tree-sitter sees it as paragraph
function handleCodeFenceInParagraph(
    newContent: string,
    actualFromIndex: number,
    actualToIndex: number,
    content: string,
    existingSegments: StreamingChunk[],
    currentUtf16Offset: number,
    config?: ParserConfig
): { handled: boolean; segments: StreamingChunk[]; utf16Consumed: number } {
    const segments = [...existingSegments]
    let utf16Consumed = 0

    // Find code fence opening (```)
    const fenceStart = newContent.indexOf('```')
    if (fenceStart === -1) {
        // No fence in new content - check if we're inside an existing code block
        const contentBeforeThis = content.substring(0, actualFromIndex)
        const fenceCount = countOccurrences(contentBeforeThis, '```')
        const isInsideCodeBlockContext = fenceCount % 2 === 1

        if (isInsideCodeBlockContext) {
            const closingFenceIdx = newContent.indexOf('```')

            if (closingFenceIdx === -1) {
                // No closing fence - emit as code block content
                return {
                    handled: true,
                    segments: [createCodeBlockChunk(newContent, currentUtf16Offset, '', {
                        original: config?.includeRawStreamedToken ? newContent : undefined
                    })],
                    utf16Consumed: newContent.length
                }
            } else {
                // Has closing fence
                const codeContent = newContent.substring(0, closingFenceIdx)
                const afterFence = newContent.substring(closingFenceIdx + 3)
                let offset = currentUtf16Offset

                if (codeContent.length > 0) {
                    segments.push(createCodeBlockChunk(codeContent, offset, '', {
                        original: config?.includeRawStreamedToken ? codeContent : undefined
                    }))
                    offset += codeContent.length
                }

                // Skip the fence markers
                offset += 3

                const textAfterFence = stripLeadingNewline(afterFence)
                if (textAfterFence.length > 0) {
                    segments.push(createPlainTextChunk(textAfterFence, offset, {
                        original: config?.includeRawStreamedToken ? textAfterFence : undefined
                    }))
                }

                return { handled: true, segments, utf16Consumed: newContent.length }
            }
        }

        return { handled: false, segments, utf16Consumed: 0 }
    }

    // Extract language from fence line (```language)
    const afterFenceMarker = newContent.substring(fenceStart + 3)
    const newlineIdx = afterFenceMarker.indexOf('\n')
    const fenceLanguage = newlineIdx === -1
        ? afterFenceMarker.trim()
        : afterFenceMarker.substring(0, newlineIdx).trim()
    const fenceMarkerLength = 3 + (newlineIdx === -1 ? afterFenceMarker.length : newlineIdx + 1)

    // Check for closing fence
    const contentAfterOpening = newlineIdx === -1
        ? ''
        : afterFenceMarker.substring(newlineIdx + 1)
    const closingFenceIdx = contentAfterOpening.indexOf('```')

    // Content BEFORE the fence
    const contentBeforeFence = newContent.substring(0, fenceStart)
    let offset = currentUtf16Offset

    if (closingFenceIdx === -1) {
        // No closing fence yet - emit content before fence and buffer the rest
        if (contentBeforeFence.trim().length > 0) {
            segments.push(createPlainTextChunk(contentBeforeFence, offset, {
                original: config?.includeRawStreamedToken ? contentBeforeFence : undefined
            }))
            utf16Consumed += contentBeforeFence.length
        }

        return { handled: true, segments, utf16Consumed }
    }

    // Complete code block structure
    if (contentBeforeFence.trim().length > 0) {
        segments.push(createPlainTextChunk(contentBeforeFence, offset, {
            original: config?.includeRawStreamedToken ? contentBeforeFence : undefined
        }))
        offset += contentBeforeFence.length
    }

    // Skip fence marker
    offset += fenceMarkerLength

    const codeContent = contentAfterOpening.substring(0, closingFenceIdx)

    if (codeContent.length > 0) {
        segments.push(createCodeBlockChunk(codeContent, offset, fenceLanguage, {
            original: config?.includeRawStreamedToken ? codeContent : undefined
        }))
        offset += codeContent.length
    }

    // Skip closing fence
    offset += 3

    const afterClosingFence = contentAfterOpening.substring(closingFenceIdx + 3)
    const textAfterFence = stripLeadingNewline(afterClosingFence)
    if (textAfterFence.trim().length > 0) {
        segments.push(createPlainTextChunk(textAfterFence, offset, {
            original: config?.includeRawStreamedToken ? textAfterFence : undefined
        }))
    }

    return { handled: true, segments, utf16Consumed: newContent.length }
}

// Count occurrences of a substring
function countOccurrences(str: string, substr: string): number {
    let count = 0
    let pos = 0
    while ((pos = str.indexOf(substr, pos)) !== -1) {
        count++
        pos += substr.length
    }
    return count
}

// Strip leading newline if present
function stripLeadingNewline(str: string): string {
    if (str.startsWith('\n')) {
        return str.substring(1)
    }
    return str
}

