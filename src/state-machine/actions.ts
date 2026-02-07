'use strict';

import {
    BLOCK_TYPES,
    REGEX,
    INLINE_STYLE_GROUPS
} from './constants.ts';
import { truncateTrailingNewLine } from './utils.ts';

import type { Context } from './markdown-state-machine.ts'

type MatchObject = {
    fullMatch: string;
    content: string;
    prefixedContent?: string;
    postfixedContent?: string;
    openingStyleMarker?: string;
    closingStyleMarker?: string;
}

export type ParsedSegment = {
    segment: string
    content?: string
    type: string
    styles: any[]
    language?: string
    level?: number
    origin?: string
    isProcessingNewLine: boolean
    isBlockDefining: boolean
}

export type ActionParams = {
    styleGroup?: string
    match?: string
    origin?: string
    emitter?: (blockContent: ParsedSegment) => void
    isTruncateTrailingNewLine?: boolean
    skipStyles?: boolean
    isDebug?: boolean
    styleGroups?: any
}

export type ActionEvent = {
    value?: any
    segment?: string
}

const setIsProcessingNewLine = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    isProcessingNewLine: event.value
})

const setIsProcessingStylingMarkerSegment = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    isProcessingStylingMarkerSegment: event.value
})

const setHeader = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
) => {
    const match = (event.segment ?? '').match(REGEX.headerMarker!);
    if (match) {
        const hashes = match[1]!
        const headerFirstSegment = match[2]! // The first segment of the header

        return {
            blockType: BLOCK_TYPES.header,
            headerLevel: hashes.length - 1,
            isBlockDefining: true, // Mark as blockDefining when transitioning to a new block type
        }
    }
}

const applyInlineTextStyle = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => {
    const { styleGroup, match } = params;
    if (!styleGroup) return {};

    let matchObject: MatchObject = {
        fullMatch: '',
        content: ''
    };

    switch (match) {
        case 'full':
            matchObject = (([
                fullMatch,
                prefixedContent,
                openingStyleMarker,
                content,
                closingStyleMarker,
                postfixedContent
            ]) => ({
                fullMatch: fullMatch || '',
                prefixedContent: prefixedContent || '',
                openingStyleMarker: openingStyleMarker || '',
                content: content || '',
                closingStyleMarker: closingStyleMarker || '',
                postfixedContent: postfixedContent || ''
            }))((event.segment ?? '').match(INLINE_STYLE_GROUPS[styleGroup]!.regex.full) || []);
            break;
        case 'partial::start':
            matchObject = (([
                fullMatch,
                prefixedContent,
                openingStyleMarker,
                content,
            ]) => ({
                fullMatch: fullMatch || '',
                prefixedContent: prefixedContent || '',
                openingStyleMarker: openingStyleMarker || '',
                content: content || '',
            }))((event.segment ?? '').match(INLINE_STYLE_GROUPS[styleGroup]!.regex.partialStart) || []);
            break;
        case 'partial::end':
            matchObject = (([
                fullMatch,
                content,
                closingStyleMarker,
                postfixedContent
            ]) => ({
                fullMatch: fullMatch || '',
                content: content || '',
                closingStyleMarker: closingStyleMarker || '',
                postfixedContent: postfixedContent || ''
            }))((event.segment ?? '').match(INLINE_STYLE_GROUPS[styleGroup]!.regex.partialEnd) || []);
            break;
    }

    let parsedSegment = matchObject.content;

    if(!matchObject.postfixedContent) {     // If there's no postfixed content, add a space to the parsed segment
        parsedSegment = `${parsedSegment} `;
    }

    return {
        prefixedContent: matchObject.prefixedContent,
        postfixedContent: matchObject.postfixedContent,
        parsedSegment,
        styles: INLINE_STYLE_GROUPS[styleGroup]!.styles,
    }
}

const setParagraph = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    blockType: BLOCK_TYPES.paragraph,
    isBlockDefining: ((context.blockType !== BLOCK_TYPES.paragraph) || context.isProcessingNewLine) ? true : false, // Mark as blockDefining when transitioning to a new block type
})

const setCodeBlock = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => {
    const matchObject = (([
        fullMatch,
        backticks,
        codeLanguage,
        postfixedContent
    ]) => ({
        fullMatch: fullMatch || '',
        backticks: backticks || '',
        codeLanguage: codeLanguage || '',
        postfixedContent: postfixedContent || '',
    }))((event.segment ?? '').match(REGEX.codeBlockStartMarker!) || []);

    return {
        blockType: BLOCK_TYPES.codeBlock,
        codeBlockLanguage: matchObject.codeLanguage,
        isBlockDefining: true, // Mark as blockDefining when transitioning to a new block type
    }
}

const debugParsedSegment = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): void => {
    console.log({origin: params.origin, parsedSegment: context})
}

const bufferBlockContent = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    blockContentBuffer: context.blockContentBuffer + (event.segment ?? '')
})

const bufferCodeBlockSegments = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    codeBlockSegmentsBuffer: [...context.codeBlockSegmentsBuffer, event.segment ?? '']
})

const resetBlockContentBuffer = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    blockContentBuffer: ''
})

const resetCodeBlockSegmentsBuffer = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    codeBlockSegmentsBuffer: []
})

const resetInlineTextStyle = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    styles: []
})

const resetPrefixedContent = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    parsedSegmentPrefixedContent: ''
})

const resetPostfixedContent = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => ({
    parsedSegmentPostfixedContent: ''
})

const emitParsedSegment = (
    context: Context,
    event: ActionEvent,
    params: ActionParams
): Partial<Context> => {
    const {
        emitter = (blockContent) => console.error('emitParsedSegment emitter function is not set, using default value:', blockContent),
        isTruncateTrailingNewLine = false,
        skipStyles = false,
        isDebug = false
    } = params;

    const segment = isTruncateTrailingNewLine ? truncateTrailingNewLine(event.segment ?? '') : (event.segment ?? '');
    const styles = skipStyles ? [] : context.styles;

    const blockContent: ParsedSegment = {
        ...(context.blockType === BLOCK_TYPES.codeBlock && { language: context.codeBlockLanguage }),
        ...(context.blockType === BLOCK_TYPES.header && { level: context.headerLevel }),
        segment,
        styles,
        type: context.blockType,
        isBlockDefining: context.isBlockDefining,
        isProcessingNewLine: context.isProcessingNewLine,
        ...(isDebug && {content: context.blockContentBuffer}),
        ...(isDebug && {origin: `${params.origin || null}`}),
    }

    // Emit parsed segment
    emitter(blockContent)

    // And mutate the context after
    return {
        isBlockDefining: false,
        isProcessingNewLine: false,
    }
}

const ACTIONS: Record<string, Function> = {
    'set::header': setHeader,
    'set::isProcessingNewLine': setIsProcessingNewLine,
    'set::isProcessingStylingMarkerSegment': setIsProcessingStylingMarkerSegment,
    'set::codeBlock': setCodeBlock,
    'set::paragraph': setParagraph,

    'apply::inlineTextStyle': applyInlineTextStyle,

    'reset::blockContentBuffer': resetBlockContentBuffer,
    'reset::codeBlockSegmentsBuffer': resetCodeBlockSegmentsBuffer,
    'reset::inlineTextStyle': resetInlineTextStyle,
    'reset::prefixedContent': resetPrefixedContent,
    'reset::postfixedContent': resetPostfixedContent,

    'buffer::blockContent': bufferBlockContent,
    'buffer::codeBlockSegments': bufferCodeBlockSegments,

    'emit::parsedSegment': emitParsedSegment,

    'debug::parsedSegment': debugParsedSegment,
}

export const actionRunner = (
    actionName: string, // Accept any string
    context: Context,
    event: any,
    params: ActionParams
) => {
    if (ACTIONS.hasOwnProperty(actionName) === false) {
        throw new Error(`No action found for: ${actionName}`);
    }
    return ACTIONS[actionName]!(context, event, params);
}
