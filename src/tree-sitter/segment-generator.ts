import type { Parser, Tree, Node } from 'web-tree-sitter'
import type {
    StreamingChunk,
    BlockInfo,
    SegmentGeneratorState,
    OpenSpan,
    ClosedSpan,
    SpanType,
    ParserConfig
} from './types.ts'
import { HEADER_MARKER_LEVELS, SUPPRESSED_SYNTAX_TYPES } from './types.ts'
import { findActiveNodeAtPosition, findInlineNodeAtPosition, findBlockNode } from './tree-navigation.ts'
import { getBlockInfo } from './block-detection.ts'
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
    isInsideCodeBlock
} from './inline-detection.ts'
import { getHeaderContent, getCodeBlockContent, getInlineContent } from './content-extraction.ts'
import { isInsideTableDelimiterRow } from './table-support.ts'
import {
    createChunkFromBlockInfo,
    createPlainTextChunk,

    createOpenSpan,
    createClosedSpan,
    createLinkSpan,
    createImageSpan
} from './segment-builder.ts'
import {
    getListSuppressedRanges,
    isAtListItemContentStart,
    isListScopedBlockContinuation,
    stripListSuppressedRanges
} from './list-support.ts'

export type SegmentGeneratorContext = {
    content: string
    currentTree: Tree
    inlineParser: Parser | null
    state: SegmentGeneratorState
    config?: ParserConfig
    disableBlockBoundarySplit?: boolean
}

// Create initial segment generator state
export function createInitialState(): SegmentGeneratorState {
    return {
        totalUtf16Offset: 0,
        lastEmittedOffset: 0,
        sourceOffset: 0,
        lastEmittedSourceOffset: 0,
        openSpans: [],
        currentBlock: null,
        pendingInlineContent: '',
        checkpoints: []
    }
}

export function createCheckpoint(state: SegmentGeneratorState): SegmentGeneratorState['checkpoints'][number] {
    return {
        sourceOffset: state.sourceOffset,
        renderedOffset: state.totalUtf16Offset,
        lastEmittedSourceOffset: state.lastEmittedSourceOffset,
        lastEmittedOffset: state.lastEmittedOffset,
        openSpans: state.openSpans.map(span => ({ ...span })),
        currentBlock: state.currentBlock ? { ...state.currentBlock } : null,
        pendingInlineContent: state.pendingInlineContent,
        pendingInlineStartIndex: state.pendingInlineStartIndex,
    }
}

export function stateFromCheckpoint(checkpoint: SegmentGeneratorState['checkpoints'][number]): SegmentGeneratorState {
    return {
        totalUtf16Offset: checkpoint.renderedOffset,
        lastEmittedOffset: checkpoint.lastEmittedOffset,
        sourceOffset: checkpoint.sourceOffset,
        lastEmittedSourceOffset: checkpoint.lastEmittedSourceOffset,
        openSpans: checkpoint.openSpans.map(span => ({ ...span })),
        currentBlock: checkpoint.currentBlock ? { ...checkpoint.currentBlock } : null,
        pendingInlineContent: checkpoint.pendingInlineContent,
        pendingInlineStartIndex: checkpoint.pendingInlineStartIndex,
        checkpoints: [checkpoint],
    }
}

function withCheckpoint(state: SegmentGeneratorState): SegmentGeneratorState {
    const checkpoint = createCheckpoint(state)
    const checkpoints = [...state.checkpoints, checkpoint]
    return {
        ...state,
        checkpoints,
    }
}

function findFirstBlockBoundaryInRange(
    node: Node,
    fromIndex: number,
    toIndex: number
): number | undefined {
    let boundary: number | undefined

    const visit = (current: Node) => {
        if (current.endIndex <= fromIndex || current.startIndex >= toIndex) {
            return
        }

        if (current.type === 'fenced_code_block' && current.startIndex > fromIndex && current.startIndex < toIndex) {
            boundary = Math.min(boundary ?? Infinity, current.startIndex)
            return
        }

        for (const child of current.children) {
            visit(child)
        }
    }

    visit(node)
    return boundary
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
function extractSpanMetadata(node: Node): { url?: string; src?: string; alt?: string } {
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
    node: Node,
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

function collectInlineDelimiterRanges(inlineTree: Tree): Array<{ start: number; end: number }> {
    const root = inlineTree.rootNode
    const ranges: Array<{ start: number; end: number }> = []

    for (const delimiter of root.descendantsOfType('emphasis_delimiter')) {
        ranges.push({ start: delimiter.startIndex, end: delimiter.endIndex })
    }

    for (const delimiter of root.descendantsOfType('code_span_delimiter')) {
        ranges.push({ start: delimiter.startIndex, end: delimiter.endIndex })
    }

    for (const node of root.descendantsOfType('strikethrough')) {
        const firstChild = node.child(0)
        const lastChild = node.child(node.childCount - 1)
        if (firstChild?.text === '~~') {
            ranges.push({ start: firstChild.startIndex, end: firstChild.endIndex })
        }
        if (lastChild?.text === '~~') {
            ranges.push({ start: lastChild.startIndex, end: lastChild.endIndex })
        }
    }

    ranges.sort((a, b) => a.start - b.start)
    return ranges
}

function rawToRenderedOffset(rawOffset: number, delimiterRanges: Array<{ start: number; end: number }>): number {
    let renderedOffset = 0
    let cursor = 0

    for (const range of delimiterRanges) {
        if (range.start >= rawOffset) {
            break
        }

        if (cursor < range.start) {
            renderedOffset += Math.max(0, Math.min(range.start, rawOffset) - cursor)
        }

        cursor = Math.max(cursor, range.end)
        if (cursor >= rawOffset) {
            return renderedOffset
        }
    }

    if (cursor < rawOffset) {
        renderedOffset += rawOffset - cursor
    }

    return renderedOffset
}

// Process a single style node and categorize it
function categorizeSpanNode(
    node: Node,
    content: string,
    chunkStartRaw: number,
    chunkEndRaw: number,
    openSpans: OpenSpan[],
    delimiterRanges: Array<{ start: number; end: number }>,
    baseRenderedOffset: number
): {
    contained?: ClosedSpan
    opening?: OpenSpan
    closing?: ClosedSpan
    closedOpenIndex?: number
} {
    const spanType = detectSpanType(node.type)
    if (!spanType) return {}

    // node.startIndex/endIndex are already UTF-16 character offsets in web-tree-sitter JS bindings
    const spanStartRaw = node.startIndex
    const spanEndRaw = node.endIndex
    const spanStartUtf16 = baseRenderedOffset + rawToRenderedOffset(spanStartRaw, delimiterRanges)
    const spanEndUtf16 = baseRenderedOffset + rawToRenderedOffset(spanEndRaw, delimiterRanges)
    const spanLength = spanEndUtf16 - spanStartUtf16

    // Fully contained
    if (isSpanContained(spanStartRaw, spanEndRaw, chunkStartRaw, chunkEndRaw)) {
        const span = createClosedSpanFromNode(spanType, node, spanStartUtf16, spanLength)
        return span ? { contained: span } : {}
    }

    // Opens here, closes later
    if (isSpanOpening(spanStartRaw, spanEndRaw, chunkStartRaw, chunkEndRaw)) {
        return { opening: createOpenSpan(spanType, spanStartUtf16) }
    }

    // Opened earlier, closes here
    if (isSpanClosing(spanStartRaw, spanEndRaw, chunkStartRaw, chunkEndRaw)) {
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
    inlineTree: Tree,
    chunkStartRaw: number,
    chunkEndRaw: number,
    content: string,
    state: SegmentGeneratorState,
    delimiterRanges: Array<{ start: number; end: number }>,
    baseRenderedOffset: number
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
            const result = categorizeSpanNode(node, content, chunkStartRaw, chunkEndRaw, newOpenSpans, delimiterRanges, baseRenderedOffset)

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

    // Public offsets are rendered-output UTF-16 offsets. Source offsets stay internal.
    const chunkStartUtf16 = state.totalUtf16Offset

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
                state.sourceOffset = actualToIndex
                return { segments, state }
            }
        }

        // Check for unmatched bold markers
        if (newPortion.includes('**')) {
            const hasCompleteBold = hasCompleteBoldAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteBold) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                state.sourceOffset = actualToIndex
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
                    state.sourceOffset = actualToIndex
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
                state.sourceOffset = actualToIndex
                return { segments, state }
            }
        }

        // Check for incomplete link opening [
        if (newPortion.includes('[')) {
            const hasCompleteLink = hasCompleteLinkAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteLink && hasIncompleteLinkOpening(newPortion, inlineParser)) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                state.sourceOffset = actualToIndex
                return { segments, state }
            }
        }

        // Check for incomplete image opening ![
        if (newPortion.includes('![')) {
            const hasCompleteImage = hasCompleteImageAt(inlineTree.rootNode, newPortionStart, newPortionEnd)
            if (!hasCompleteImage && hasIncompleteImageOpening(newPortion, inlineParser)) {
                state.pendingInlineContent = newContent
                state.pendingInlineStartIndex = actualFromIndex
                state.sourceOffset = actualToIndex
                return { segments, state }
            }
        }
    }

    // Skip empty content
    if (!newContent) {
        return { segments, state }
    }

    if (!context.disableBlockBoundarySplit) {
        const boundary = findFirstBlockBoundaryInRange(currentTree.rootNode, actualFromIndex, actualToIndex)
        if (boundary !== undefined) {
            const prefix = generateSegments(actualFromIndex, boundary, {
                ...context,
                state,
                disableBlockBoundarySplit: true,
            })
            state = prefix.state

            const suffix = generateSegments(boundary, actualToIndex, {
                ...context,
                state,
                disableBlockBoundarySplit: true,
            })

            return {
                segments: [...prefix.segments, ...suffix.segments],
                state: suffix.state,
            }
        }
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
            totalUtf16Offset: chunkStartUtf16 + newContent.length,
            lastEmittedOffset: chunkStartUtf16 + newContent.length,
            sourceOffset: actualToIndex,
            lastEmittedSourceOffset: actualToIndex,
        }
        state = withCheckpoint(state)
        return { segments: [chunk], state }
    }

    const leadingSuppressedRange = getListSuppressedRanges(
        currentTree.rootNode,
        content,
        actualFromIndex,
        actualToIndex
    ).find(range => range.start === actualFromIndex)

    if (leadingSuppressedRange) {
        const suppressedEnd = leadingSuppressedRange.end
        state = {
            ...state,
            sourceOffset: suppressedEnd,
        }

        if (suppressedEnd >= actualToIndex) {
            state = withCheckpoint(state)
            return { segments, state }
        }

        return generateSegments(suppressedEnd, actualToIndex, {
            ...context,
            state,
            disableBlockBoundarySplit: true,
        })
    }

    if (isListScopedBlockContinuation(nodeAtPosition)) {
        const continuationEnd = Math.min(nodeAtPosition.endIndex, actualToIndex)
        state = {
            ...state,
            sourceOffset: continuationEnd,
        }

        if (continuationEnd >= actualToIndex) {
            state = withCheckpoint(state)
            return { segments, state }
        }

        return generateSegments(continuationEnd, actualToIndex, {
            ...context,
            state,
            disableBlockBoundarySplit: true,
        })
    }

    // Check if the node is a suppressed syntax type
    if (SUPPRESSED_SYNTAX_TYPES.indexOf(nodeAtPosition.type as typeof SUPPRESSED_SYNTAX_TYPES[number]) !== -1) {
        state = {
            ...state,
            sourceOffset: actualToIndex,
        }
        state = withCheckpoint(state)
        return { segments, state }
    }

    // Check if we're inside a table delimiter row
    if (isInsideTableDelimiterRow(nodeAtPosition)) {
        state = {
            ...state,
            sourceOffset: actualToIndex,
        }
        state = withCheckpoint(state)
        return { segments, state }
    }

    // Determine the block type and properties
    const blockInfo = getBlockInfo(nodeAtPosition)

    if (blockInfo.list && isAtListItemContentStart(nodeAtPosition, actualFromIndex) && /^\[[ xX]?$/.test(newContent)) {
        state.pendingInlineContent = newContent
        state.pendingInlineStartIndex = actualFromIndex
        state.sourceOffset = actualToIndex
        return { segments, state }
    }

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
            state = {
                ...state,
                sourceOffset: actualToIndex,
            }
            state = withCheckpoint(state)
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
            state = {
                ...state,
                sourceOffset: actualToIndex,
            }
            state = withCheckpoint(state)
            return { segments, state }
        }
    } else if (blockInfo.type === 'paragraph') {
        // Handle incomplete header markers
        if (nodeAtPosition.type in HEADER_MARKER_LEVELS) {
            state = {
                ...state,
                sourceOffset: actualToIndex,
            }
            state = withCheckpoint(state)
            return { segments, state }
        }

    }

    // Process inline spans for non-codeBlock types
    let opening: OpenSpan[] = []
    let closing: ClosedSpan[] = []
    let contained: ClosedSpan[] = []
    let strippedContent = processedContent
    let usedInlineContent = false

    if (blockInfo.type !== 'codeBlock' && inlineParser) {
        const hostInlineNode = findInlineNodeAtPosition(currentTree.rootNode, actualFromIndex)
        usedInlineContent = hostInlineNode !== null
        const inlineContent = hostInlineNode?.text ?? processedContent
        const inlineTree = inlineParser.parse(inlineContent)
        const delimiterRanges = collectInlineDelimiterRanges(inlineTree)
        const chunkStartInInline = hostInlineNode
            ? Math.max(0, actualFromIndex - hostInlineNode.startIndex)
            : 0
        const chunkEndInInline = hostInlineNode
            ? Math.max(chunkStartInInline, actualToIndex - hostInlineNode.startIndex)
            : processedContent.length

        const spanResult = processInlineSpans(
            inlineTree,
            chunkStartInInline,
            chunkEndInInline,
            inlineContent,
            state,
            delimiterRanges,
            chunkStartUtf16 - rawToRenderedOffset(chunkStartInInline, delimiterRanges)
        )
        opening = spanResult.opening
        closing = spanResult.closing
        contained = spanResult.contained
        state = { ...state, openSpans: spanResult.newOpenSpans }

        // Strip inline markers from the content
        strippedContent = getInlineContent(
            hostInlineNode ? inlineContent.substring(chunkStartInInline, chunkEndInInline) : processedContent,
            inlineTree,
            chunkStartInInline,
            chunkEndInInline
        )

        if (hostInlineNode && blockInfo.type !== 'header' && actualToIndex > hostInlineNode.endIndex) {
            const tailStart = Math.max(actualFromIndex, hostInlineNode.endIndex)
            const tailText = content.substring(tailStart, actualToIndex)
            strippedContent += stripListSuppressedRanges(tailText, currentTree.rootNode, content, tailStart, actualToIndex)
        }
    }

    if (blockInfo.type !== 'codeBlock' && !usedInlineContent) {
        strippedContent = stripListSuppressedRanges(
            strippedContent,
            currentTree.rootNode,
            content,
            actualFromIndex,
            actualToIndex
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
        totalUtf16Offset: chunkStartUtf16 + strippedContent.length,
        lastEmittedOffset: chunkStartUtf16 + strippedContent.length,
        sourceOffset: actualToIndex,
        lastEmittedSourceOffset: actualToIndex,
        currentBlock: {
            type: blockInfo.type,
            level: blockInfo.level,
            language: blockInfo.language,
            startIndex: nodeAtPosition.startIndex,
            lastSegmentEnd: actualToIndex,
            hasEmittedContent: true
        }
    }
    state = withCheckpoint(state)

    return { segments, state }
}
