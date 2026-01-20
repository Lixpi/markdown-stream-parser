import type { Parser } from 'web-tree-sitter';
import type { StreamingChunk, BlockState, BlockInfo, HEADER_MARKER_LEVELS, SUPPRESSED_SYNTAX_TYPES } from './types.js';
import { findActiveNodeAtPosition, findInlineNodeAtPosition, findBlockNode } from './tree-navigation.js';
import { getBlockInfo, isNewBlock } from './block-detection.js';
import {
    detectActiveStyles,
    hasCompleteCodeSpanAt,
    hasCompleteBoldAt,
    hasCompleteItalicAt,
    hasCompleteStrikethroughAt,
    hasUnmatchedItalicMarker,
    isInsideCodeBlock
} from './inline-detection.js';
import { getHeaderContent, getCodeBlockContent } from './content-extraction.js';
import {
    getInlineCodeSegments,
    getBoldSegments,
    getItalicSegments,
    getStrikethroughSegments
} from './inline-extractors.js';
import { createStreamingChunk, createChunkFromBlockInfo, createPlainTextChunk, createCodeBlockChunk } from './segment-builder.js';

// Re-import the constant that we need locally
const HEADER_MARKER_LEVELS_LOCAL: Record<string, number> = {
    'atx_h1_marker': 1,
    'atx_h2_marker': 2,
    'atx_h3_marker': 3,
    'atx_h4_marker': 4,
    'atx_h5_marker': 5,
    'atx_h6_marker': 6,
};

const SUPPRESSED_SYNTAX_TYPES_LOCAL = [
    'list_marker_minus', 'list_marker_plus', 'list_marker_star',
    'list_marker_dot', 'list_marker_parenthesis',
    '|'  // Table pipe delimiters
];

export interface SegmentGeneratorState {
    pendingInlineContent: string;
    pendingInlineStartIndex: number;
    currentBlock: BlockState | null;
}

export interface SegmentGeneratorContext {
    content: string;
    currentTree: Parser.Tree;
    inlineParser: Parser | null;
    state: SegmentGeneratorState;
}

/**
 * Generate segments for a range of content.
 * This is the main segment generation function that handles all the complex logic.
 */
export function generateSegments(
    fromIndex: number,
    toIndex: number,
    context: SegmentGeneratorContext
): { segments: StreamingChunk[]; state: SegmentGeneratorState } {
    const { content, currentTree, inlineParser } = context;
    let state = { ...context.state };

    if (!currentTree) {
        return { segments: [], state };
    }

    const segments: StreamingChunk[] = [];
    let newContent = content.substring(fromIndex, toIndex);
    let actualFromIndex = fromIndex;
    let actualToIndex = toIndex;

    // Check if we have pending inline content from previous incomplete structure
    if (state.pendingInlineContent) {
        // Prepend pending content
        newContent = state.pendingInlineContent + newContent;
        actualFromIndex = state.pendingInlineStartIndex;
        state.pendingInlineContent = '';
    }

    // Check if current content has unmatched inline delimiters
    const inlineNode = findInlineNodeAtPosition(currentTree.rootNode, actualFromIndex);
    if (inlineNode && inlineParser) {
        const inlineContent = inlineNode.text;
        const inlineTree = inlineParser.parse(inlineContent);

        // Count the range in the new portion
        const newPortionStart = actualFromIndex - inlineNode.startIndex;
        const newPortionEnd = actualToIndex - inlineNode.startIndex;
        const newPortion = inlineContent.substring(Math.max(0, newPortionStart), newPortionEnd);

        // Check for unmatched backtick
        if (newPortion.includes('`')) {
            const hasCompleteCodeSpan = hasCompleteCodeSpanAt(inlineTree.rootNode, newPortionStart, newPortionEnd);
            if (!hasCompleteCodeSpan) {
                state.pendingInlineContent = newContent;
                state.pendingInlineStartIndex = actualFromIndex;
                return { segments, state };
            }
        }

        // Check for unmatched bold markers
        if (newPortion.includes('**')) {
            const hasCompleteBold = hasCompleteBoldAt(inlineTree.rootNode, newPortionStart, newPortionEnd);
            if (!hasCompleteBold) {
                state.pendingInlineContent = newContent;
                state.pendingInlineStartIndex = actualFromIndex;
                return { segments, state };
            }
        }

        // Check for unmatched italic markers (skip if inside code block)
        const insideCodeBlock = isInsideCodeBlock(currentTree.rootNode, actualFromIndex, currentTree, inlineParser);
        if (!insideCodeBlock) {
            const hasUnmatchedItalic = hasUnmatchedItalicMarker(newPortion, inlineParser);
            if (hasUnmatchedItalic) {
                const hasCompleteItalic = hasCompleteItalicAt(inlineTree.rootNode, newPortionStart, newPortionEnd);
                if (!hasCompleteItalic) {
                    state.pendingInlineContent = newContent;
                    state.pendingInlineStartIndex = actualFromIndex;
                    return { segments, state };
                }
            }
        }

        // Check for unmatched strikethrough markers
        if (newPortion.includes('~~')) {
            const hasCompleteStrikethrough = hasCompleteStrikethroughAt(inlineTree.rootNode, newPortionStart, newPortionEnd);
            if (!hasCompleteStrikethrough) {
                state.pendingInlineContent = newContent;
                state.pendingInlineStartIndex = actualFromIndex;
                return { segments, state };
            }
        }
    }

    // Skip empty content
    if (!newContent) {
        return { segments, state };
    }

    // Find the deepest node containing the new content position
    const nodeAtPosition = findActiveNodeAtPosition(currentTree.rootNode, actualFromIndex);

    if (!nodeAtPosition) {
        // If no node found, treat as plain text
        return {
            segments: [createPlainTextChunk(newContent)],
            state
        };
    }

    // Check if the node is a suppressed syntax type
    if (SUPPRESSED_SYNTAX_TYPES_LOCAL.indexOf(nodeAtPosition.type) !== -1) {
        return { segments, state };
    }

    // Check if we're inside a table delimiter row
    let currentForDelimiter: Parser.SyntaxNode | null = nodeAtPosition;
    while (currentForDelimiter) {
        if (currentForDelimiter.type === 'pipe_table_delimiter_row' ||
            currentForDelimiter.type === 'pipe_table_delimiter_cell') {
            return { segments, state };
        }
        currentForDelimiter = currentForDelimiter.parent;
    }

    // Determine the block type and properties
    const blockInfo = getBlockInfo(nodeAtPosition);

    // Check if we're starting a new block
    const isNewBlockFlag = isNewBlock(blockInfo, nodeAtPosition, state.currentBlock);

    // Detect styles in the current context
    const styles = detectActiveStyles(nodeAtPosition, actualFromIndex, actualToIndex, currentTree, inlineParser);

    // Process content based on block type
    let processedContent = newContent;

    if (blockInfo.type === 'header') {
        const blockNode = findBlockNode(nodeAtPosition);
        try {
            processedContent = getHeaderContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex);
        } catch (e) {
            console.warn('[PARSER] Failed to extract header content, using raw:', e);
            processedContent = newContent;
        }

        // Don't emit if it's only markers
        if (processedContent.length === 0 || processedContent.trim().length === 0) {
            state = updateBlockState(state, isNewBlockFlag, blockInfo, nodeAtPosition, actualToIndex, styles, false);
            return { segments, state };
        }
    } else if (blockInfo.type === 'codeBlock') {
        const blockNode = findBlockNode(nodeAtPosition);
        try {
            processedContent = getCodeBlockContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex);
        } catch (e) {
            console.warn('[PARSER] Failed to extract code block content, using raw:', e);
            processedContent = newContent;
        }

        if (processedContent.length === 0) {
            state = updateBlockState(state, isNewBlockFlag, blockInfo, nodeAtPosition, actualToIndex, styles, false);
            return { segments, state };
        }
    } else if (blockInfo.type === 'paragraph') {
        // Handle incomplete header markers
        if (nodeAtPosition.type in HEADER_MARKER_LEVELS_LOCAL) {
            return { segments, state };
        }

        // Handle code fence detection in paragraph content
        const result = handleCodeFenceInParagraph(newContent, actualFromIndex, actualToIndex, content, segments);
        if (result.handled) {
            return { segments: result.segments, state };
        }
    }

    // Process inline styles for non-codeBlock types
    if (blockInfo.type !== 'codeBlock') {
        const inlineResult = processInlineStyles(
            processedContent, nodeAtPosition, actualFromIndex, actualToIndex,
            styles, blockInfo, isNewBlockFlag, state, currentTree, inlineParser!
        );

        if (inlineResult.handled) {
            return { segments: inlineResult.segments, state: inlineResult.state };
        }
    }

    // Determine effective block defining status
    let effectiveIsBlockDefining = isNewBlockFlag;
    if (!isNewBlockFlag && state.currentBlock && !state.currentBlock.hasEmittedContent && state.currentBlock.type === blockInfo.type) {
        effectiveIsBlockDefining = true;
    }

    // Create and push the segment
    segments.push(createChunkFromBlockInfo(
        processedContent,
        styles,
        blockInfo,
        effectiveIsBlockDefining,
        newContent.includes('\n')
    ));

    // Update block tracking
    state = updateBlockState(state, isNewBlockFlag, blockInfo, nodeAtPosition, actualToIndex, styles, true);

    return { segments, state };
}

/**
 * Update the block state after processing content
 */
function updateBlockState(
    state: SegmentGeneratorState,
    isNewBlockFlag: boolean,
    blockInfo: BlockInfo,
    nodeAtPosition: Parser.SyntaxNode,
    actualToIndex: number,
    styles: string[],
    hasEmittedContent: boolean
): SegmentGeneratorState {
    const newState = { ...state };

    if (isNewBlockFlag) {
        newState.currentBlock = {
            type: blockInfo.type,
            level: blockInfo.level,
            language: blockInfo.language,
            startIndex: nodeAtPosition.startIndex,
            lastSegmentEnd: actualToIndex,
            styles: new Set(styles),
            hasEmittedContent
        };
    } else if (newState.currentBlock) {
        newState.currentBlock = { ...newState.currentBlock };
        newState.currentBlock.lastSegmentEnd = actualToIndex;
        newState.currentBlock.hasEmittedContent = newState.currentBlock.hasEmittedContent || hasEmittedContent;
        styles.forEach(s => newState.currentBlock!.styles.add(s));
    }

    return newState;
}

/**
 * Handle code fence detection when tree-sitter sees it as paragraph
 */
function handleCodeFenceInParagraph(
    newContent: string,
    actualFromIndex: number,
    actualToIndex: number,
    content: string,
    existingSegments: StreamingChunk[]
): { handled: boolean; segments: StreamingChunk[] } {
    const segments = [...existingSegments];

    // Check if new content contains a code fence opening
    const codeFenceOpeningMatch = newContent.match(/```([a-zA-Z0-9]*)\n?/);
    if (!codeFenceOpeningMatch) {
        // Also check for content MIDDLE of a code block
        const contentBeforeThis = content.substring(0, actualFromIndex);
        const allFences = contentBeforeThis.match(/```/g) || [];
        const isInsideCodeBlockContext = allFences.length % 2 === 1;

        if (isInsideCodeBlockContext) {
            const closingFenceIdx = newContent.indexOf('```');

            if (closingFenceIdx === -1) {
                // No closing fence - emit as code block content
                return {
                    handled: true,
                    segments: [createCodeBlockChunk(newContent)]
                };
            } else {
                // Has closing fence
                const codeContent = newContent.substring(0, closingFenceIdx);
                const afterFence = newContent.substring(closingFenceIdx + 3);

                if (codeContent.length > 0) {
                    segments.push(createCodeBlockChunk(codeContent));
                }

                const textAfterFence = afterFence.replace(/^\n/, '');
                if (textAfterFence.length > 0) {
                    segments.push(createPlainTextChunk(textAfterFence, true));
                }

                return { handled: true, segments };
            }
        }

        return { handled: false, segments };
    }

    const fenceStart = newContent.indexOf(codeFenceOpeningMatch[0]);
    const fenceLanguage = codeFenceOpeningMatch[1] || '';
    const fenceMarker = codeFenceOpeningMatch[0];

    // Check for closing fence
    const positionOfFence = actualFromIndex + fenceStart;
    const contentFromFence = content.substring(positionOfFence);
    const closingFenceIdx = contentFromFence.substring(fenceMarker.length).indexOf('```');

    // Content BEFORE the fence
    const contentBeforeFence = newContent.substring(0, fenceStart);

    if (closingFenceIdx === -1) {
        // No closing fence yet - emit content before fence and buffer the rest
        if (contentBeforeFence.trim().length > 0) {
            segments.push(createPlainTextChunk(contentBeforeFence));
        }

        // This would need state management - return partial result
        // The caller should handle buffering
        return { handled: true, segments };
    }

    // Complete code block structure
    if (contentBeforeFence.trim().length > 0) {
        segments.push(createPlainTextChunk(contentBeforeFence));
    }

    const contentAfterOpeningFence = newContent.substring(fenceStart + fenceMarker.length);
    const closingFenceInContent = contentAfterOpeningFence.indexOf('```');

    let codeContent: string;
    if (closingFenceInContent === -1) {
        codeContent = contentAfterOpeningFence;
    } else {
        codeContent = contentAfterOpeningFence.substring(0, closingFenceInContent);
    }

    codeContent = codeContent.replace(/^\n/, '');

    if (codeContent.length > 0) {
        segments.push(createCodeBlockChunk(codeContent, fenceLanguage, true));
    }

    if (closingFenceInContent !== -1) {
        const afterClosingFence = contentAfterOpeningFence.substring(closingFenceInContent + 3);
        const textAfterFence = afterClosingFence.replace(/^\n/, '');
        if (textAfterFence.trim().length > 0) {
            segments.push(createPlainTextChunk(textAfterFence, true));
        }
    }

    return { handled: true, segments };
}

/**
 * Process inline styles and return segments if applicable
 */
function processInlineStyles(
    processedContent: string,
    nodeAtPosition: Parser.SyntaxNode,
    actualFromIndex: number,
    actualToIndex: number,
    styles: string[],
    blockInfo: BlockInfo,
    isNewBlockFlag: boolean,
    state: SegmentGeneratorState,
    currentTree: Parser.Tree,
    inlineParser: Parser
): { handled: boolean; segments: StreamingChunk[]; state: SegmentGeneratorState } {
    const styleHandlers: Array<{
        style: string;
        extractor: (content: string, node: Parser.SyntaxNode, startByte: number, endByte: number, baseStyles: string[], blockInfo: BlockInfo, currentTree: Parser.Tree, inlineParser: Parser) => StreamingChunk[]
    }> = [
            { style: 'code', extractor: getInlineCodeSegments },
            { style: 'bold', extractor: getBoldSegments },
            { style: 'italic', extractor: getItalicSegments },
            { style: 'strikethrough', extractor: getStrikethroughSegments },
        ];

    for (const { style, extractor } of styleHandlers) {
        if (styles.indexOf(style) !== -1) {
            let splitSegments: StreamingChunk[] = [];
            try {
                splitSegments = extractor(
                    processedContent, nodeAtPosition, actualFromIndex, actualToIndex,
                    styles, blockInfo, currentTree, inlineParser
                );
            } catch (e) {
                console.warn(`[PARSER] Failed to extract ${style} segments, will use default processing:`, e);
                continue;
            }

            if (splitSegments.length > 0) {
                // Determine effective block defining
                let effectiveIsBlockDefining = isNewBlockFlag;
                if (!isNewBlockFlag && state.currentBlock && !state.currentBlock.hasEmittedContent && state.currentBlock.type === blockInfo.type) {
                    effectiveIsBlockDefining = true;
                }

                // Apply block defining flag to first segment
                splitSegments.forEach((seg, index) => {
                    if (index === 0 && seg.segment) {
                        seg.segment.isBlockDefining = effectiveIsBlockDefining;
                    }
                });

                // Update state
                const newState = updateBlockState(state, isNewBlockFlag, blockInfo, nodeAtPosition, actualToIndex, styles, true);

                return { handled: true, segments: splitSegments, state: newState };
            }
        }
    }

    return { handled: false, segments: [], state };
}
