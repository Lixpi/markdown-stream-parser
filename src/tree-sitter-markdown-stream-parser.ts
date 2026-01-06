import { Parser, Language } from 'web-tree-sitter';
import TokensStreamBuffer from './tokens-stream-buffer.ts';

/**
 * Lookup map for tree-sitter ATX header marker node types to their heading levels.
 * Used for both level extraction and marker-only content detection.
 */
const HEADER_MARKER_LEVELS: Record<string, number> = {
    'atx_h1_marker': 1,
    'atx_h2_marker': 2,
    'atx_h3_marker': 3,
    'atx_h4_marker': 4,
    'atx_h5_marker': 5,
    'atx_h6_marker': 6,
};

interface StreamingSegment {
    level?: number;
    language?: string;
    segment: string;
    styles: string[];
    type: string;
    isBlockDefining: boolean;
    isProcessingNewLine: boolean;
    blockId?: number;
}


export interface StreamingChunk {
    status: string;
    segment?: StreamingSegment;
}

interface BlockState {
    type: string;
    level?: number;
    language?: string;
    startIndex: number;
    lastSegmentEnd: number;
    styles: Set<string>;
    hasEmittedContent?: boolean;
}

export class MarkdownStreamParser {
    private static instances = new Map<string, MarkdownStreamParser>();
    private static parserInitialized = false;
    private static parserInitPromise: Promise<void> | null = null;
    private static markdownLanguage: Parser.Language | null = null;
    private static markdownInlineLanguage: Parser.Language | null = null;
    private static wasmPath: string | null = null;
    private static wasmInlinePath: string | null = null;

    private parser: Parser | null = null;
    private inlineParser: Parser | null = null;
    private currentTree: Parser.Tree | null = null;
    private content: string = '';
    private lastProcessedIndex: number = 0;
    private currentBlock: BlockState | null = null;
    private allSegments: StreamingChunk[] = [];

    // Buffer for pending inline content that might be part of incomplete structures
    private pendingInlineContent: string = '';
    private pendingInlineStartIndex: number = 0;

    // Integration with TokensStreamBuffer
    private tokensStreamProcessor: TokensStreamBuffer;
    private parsing: boolean = false;
    private tokenParseListeners: Array<(chunk: StreamingChunk) => void> = [];
    private unsubscribeFromProcessor: (() => void) | null = null;

    /**
     * Configure the WASM file paths before creating any instances
     * This must be called before getInstance() if you want to use custom paths
     */
    static configureWasmPath(markdownWasmPath: string, inlineWasmPath?: string): void {
        if (MarkdownStreamParser.parserInitialized) {
            console.warn('WASM path configuration ignored - parser already initialized');
            return;
        }
        MarkdownStreamParser.wasmPath = markdownWasmPath;
        MarkdownStreamParser.wasmInlinePath = inlineWasmPath || markdownWasmPath.replace('.wasm', '-inline.wasm');
    }

    static async getInstance(instanceId: string): Promise<MarkdownStreamParser> {
        // Initialize parser and language once for all instances
        if (!MarkdownStreamParser.parserInitialized) {
            if (!MarkdownStreamParser.parserInitPromise) {
                MarkdownStreamParser.parserInitPromise = MarkdownStreamParser.initializeParser();
            }
            await MarkdownStreamParser.parserInitPromise;
        }

        if (!MarkdownStreamParser.instances.has(instanceId)) {
            const instance = new MarkdownStreamParser();
            await instance.initialize();
            MarkdownStreamParser.instances.set(instanceId, instance);
        }

        console.info(`\x1b[34mMarkdownStreamParser ->\x1b[0m getInstance::instanceId: ${instanceId}`);
        return MarkdownStreamParser.instances.get(instanceId)!;
    }

    private static async initializeParser(): Promise<void> {
        try {
            // Initialize the Parser library itself
            await Parser.init({
                locateFile(scriptName: string, scriptDirectory: string) {
                    // In Node.js/test environment, use the configured wasm directory
                    if (typeof window === 'undefined' && MarkdownStreamParser.wasmPath) {
                        // Extract directory from configured path
                        const dir = MarkdownStreamParser.wasmPath.substring(0, MarkdownStreamParser.wasmPath.lastIndexOf('/'));
                        return dir + '/' + scriptName;
                    }

                    // Browser environment
                    if (typeof window !== 'undefined') {
                        return window.location.origin + '/' + scriptName;
                    }

                    // Fallback
                    return '/' + scriptName;
                }
            });

            // Determine the correct path based on environment
            let wasmPath = MarkdownStreamParser.wasmPath;

            if (!wasmPath) {
                // Default path for browser/Vite environment
                if (typeof window !== 'undefined') {
                    wasmPath = '/tree-sitter-markdown.wasm';
                } else {
                    // Node.js environment
                    wasmPath = './wasm/tree-sitter-markdown.wasm';
                }
            }

            console.info(`Loading markdown WASM from: ${wasmPath}`);

            // Load the block language
            MarkdownStreamParser.markdownLanguage = await Language.load(wasmPath);

            // Load the inline language
            let inlineWasmPath = MarkdownStreamParser.wasmInlinePath;
            if (!inlineWasmPath) {
                if (typeof window !== 'undefined') {
                    inlineWasmPath = '/tree-sitter-markdown-inline.wasm';
                } else {
                    inlineWasmPath = './wasm/tree-sitter-markdown-inline.wasm';
                }
            }

            console.info(`Loading markdown-inline WASM from: ${inlineWasmPath}`);
            MarkdownStreamParser.markdownInlineLanguage = await Language.load(inlineWasmPath);

            MarkdownStreamParser.parserInitialized = true;
            console.info('✅ Tree-sitter markdown language loaded successfully');
            console.info('✅ Tree-sitter markdown-inline language loaded successfully');
        } catch (error) {
            console.error('Failed to load tree-sitter-markdown WASM:', error);
            throw new Error(`Failed to initialize markdown parser: ${error}`);
        }
    }

    private static getWasmPath(): string {
        // Use configured path if available
        if (MarkdownStreamParser.wasmPath) {
            return MarkdownStreamParser.wasmPath;
        }

        // For Vite/browser environment, use relative path from public directory
        if (typeof window !== 'undefined') {
            return '/tree-sitter-markdown.wasm';
        }

        // Node.js fallback
        return './wasm/tree-sitter-markdown.wasm';
    }

    static removeInstance(instanceId: string): void {
        const instance = MarkdownStreamParser.instances.get(instanceId);
        if (instance) {
            instance.stopParsing();
            MarkdownStreamParser.instances.delete(instanceId);
        }
    }

    constructor() {
        this.tokensStreamProcessor = new TokensStreamBuffer();
    }

    private async initialize(): Promise<void> {
        // Create a new parser instance for this instance
        this.parser = new Parser();
        this.inlineParser = new Parser();

        // Use the statically loaded languages
        if (!MarkdownStreamParser.markdownLanguage) {
            throw new Error('Markdown language not loaded. This should not happen if getInstance() was used.');
        }
        if (!MarkdownStreamParser.markdownInlineLanguage) {
            throw new Error('Markdown-inline language not loaded.');
        }

        // Set the language for this parser instance
        this.parser.setLanguage(MarkdownStreamParser.markdownLanguage);
        this.inlineParser.setLanguage(MarkdownStreamParser.markdownInlineLanguage);

        console.info('Parser instance initialized with markdown and markdown-inline languages');
    }

    /**
     * Subscribe to parsed tokens/segments
     * Returns an unsubscribe function
     */
    subscribeToTokenParse(listener: (chunk: StreamingChunk, unsubscribe: () => void) => void): () => void {
        const wrappedListener = (data: StreamingChunk) => {
            listener(data, unsubscribe);
        };

        const unsubscribe = () => {
            this.tokenParseListeners = this.tokenParseListeners.filter(l => l !== wrappedListener);
        };

        this.tokenParseListeners.push(wrappedListener);
        return unsubscribe;
    }

    /**
     * Notify all subscribers about a parsed token
     */
    private notifyTokenParse(chunk: StreamingChunk): void {
        this.tokenParseListeners.forEach(listener => listener(chunk));
    }

    /**
     * Start the parsing session
     */
    startParsing(): void {
        if (this.parsing) {
            console.warn('Parser is already running');
            return;
        }

        if (!this.parser) {
            throw new Error('Parser not initialized. Call getInstance() to get an initialized instance.');
        }

        // Reset state
        this.reset();

        // Notify start
        this.notifyTokenParse({ status: 'START_STREAM' });

        // Subscribe to completed segments from TokensStreamBuffer
        this.unsubscribeFromProcessor = this.tokensStreamProcessor.subscribeToSegmentCompletion((word: string) => {
            // Process the completed word/segment through tree-sitter
            const segments = this.processRawChunk(word);

            // Notify listeners about each segment
            segments.forEach(segment => {
                this.notifyTokenParse(segment);
            });
        });

        this.parsing = true;
        console.info('\x1b[32mParser started\x1b[0m');
    }

    /**
     * Parse a single token/chunk
     */
    parseToken(chunk: string): Error | void {
        if (!this.parsing) {
            const error = new Error('Parser is not started. Call startParsing() first.');
            console.error('\x1b[31mMarkdownStreamParser::parseToken::error\x1b[0m', error.message);
            return error;
        }

        // Send chunk to the token buffer for processing
        this.tokensStreamProcessor.receiveChunk(chunk);
    }

    /**
     * Stop parsing and cleanup
     */
    stopParsing(): void {
        if (!this.parsing) {
            return;
        }

        // Flush any remaining content in the buffer
        this.tokensStreamProcessor.flushBuffer();

        // Unsubscribe from token processor
        if (this.unsubscribeFromProcessor) {
            this.unsubscribeFromProcessor();
            this.unsubscribeFromProcessor = null;
        }

        // Notify end
        this.notifyTokenParse({ status: 'END_STREAM' });

        this.parsing = false;
        console.info('\x1b[32mParser stopped\x1b[0m');
    }

    /**
     * Process raw chunk through tree-sitter
     */
    private processRawChunk(chunk: string): StreamingChunk[] {
        if (!this.parser) {
            return [];
        }

        const oldLength = this.content.length;

        // Add chunk to content
        this.content += chunk;

        // Update last processed index
        this.lastProcessedIndex = this.content.length;

        // For proper incremental parsing, tell tree-sitter what changed
        if (this.currentTree) {
            // Calculate row/column for the edit positions
            // For simplicity, count newlines to get row, and chars after last newline for column
            const getPosition = (index: number) => {
                const textUpToIndex = this.content.substring(0, Math.min(index, this.content.length));
                const lines = textUpToIndex.split('\n');
                return {
                    row: lines.length - 1,
                    column: lines[lines.length - 1].length
                };
            };

            this.currentTree.edit({
                startIndex: oldLength,
                oldEndIndex: oldLength,
                newEndIndex: this.content.length,
                startPosition: getPosition(oldLength),
                oldEndPosition: getPosition(oldLength),
                newEndPosition: getPosition(this.content.length)
            });
        }

        // Parse the updated content (pass old tree for incremental parsing)
        this.currentTree = this.parser.parse(this.content, this.currentTree || undefined);

        // Generate segments for the new content
        const newSegments = this.generateSegments(oldLength, this.content.length);

        // Store all segments for debugging
        this.allSegments.push(...newSegments);

        return newSegments;
    }

    private generateSegments(fromIndex: number, toIndex: number): StreamingChunk[] {
        if (!this.currentTree) return [];

        const segments: StreamingChunk[] = [];
        let newContent = this.content.substring(fromIndex, toIndex);
        let actualFromIndex = fromIndex;
        let actualToIndex = toIndex;

        // Check if we have pending inline content from previous incomplete structure
        if (this.pendingInlineContent) {
            // Prepend pending content
            newContent = this.pendingInlineContent + newContent;
            actualFromIndex = this.pendingInlineStartIndex;
            // actualToIndex stays the same - it's still the end of the current chunk in the document
            this.pendingInlineContent = '';
        }

        // Check if current content has unmatched inline delimiters (backticks)
        const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, actualFromIndex);
        if (inlineNode && this.inlineParser) {
            const inlineContent = inlineNode.text;
            const inlineTree = this.inlineParser.parse(inlineContent);

            // Count backticks in the NEW portion to see if we have unmatched ones
            const newPortionStart = actualFromIndex - inlineNode.startIndex;
            const newPortionEnd = actualToIndex - inlineNode.startIndex;
            const newPortion = inlineContent.substring(Math.max(0, newPortionStart), newPortionEnd);

            // Check for unmatched backtick by looking at the parsed tree
            // If there's a backtick in the content but no code_span found at that position,
            // it means the structure is incomplete
            if (newPortion.includes('`')) {
                // Find if there's a code_span that covers our position
                const hasCompleteCodeSpan = this.hasCompleteCodeSpanAt(inlineTree.rootNode, newPortionStart, newPortionEnd);

                if (!hasCompleteCodeSpan) {
                    // Buffer this content - we have an unmatched backtick
                    this.pendingInlineContent = newContent;
                    this.pendingInlineStartIndex = actualFromIndex;
                    return segments; // Don't emit anything yet
                }
            }

            // Check for unmatched bold markers (**)
            // If there's ** in the content but no strong_emphasis found at that position,
            // it means the structure is incomplete
            if (newPortion.includes('**')) {
                const hasCompleteBold = this.hasCompleteBoldAt(inlineTree.rootNode, newPortionStart, newPortionEnd);

                if (!hasCompleteBold) {
                    // Buffer this content - we have an unmatched **
                    this.pendingInlineContent = newContent;
                    this.pendingInlineStartIndex = actualFromIndex;
                    return segments; // Don't emit anything yet
                }
            }

            // Check for unmatched italic markers (* or _)
            // Need to be careful not to match ** which is already handled above
            // Look for single * or _ that are not part of **
            // BUT: Skip this check if we're inside a code block (fenced_code_block)
            // because underscores in variable names are common and should not be buffered
            const isInsideCodeBlock = this.isInsideCodeBlock(this.currentTree.rootNode, actualFromIndex);

            if (!isInsideCodeBlock) {
                const hasUnmatchedItalicMarker = this.hasUnmatchedItalicMarker(newPortion);
                if (hasUnmatchedItalicMarker) {
                    const hasCompleteItalic = this.hasCompleteItalicAt(inlineTree.rootNode, newPortionStart, newPortionEnd);

                    if (!hasCompleteItalic) {
                        // Buffer this content - we have an unmatched * or _
                        this.pendingInlineContent = newContent;
                        this.pendingInlineStartIndex = actualFromIndex;
                        return segments; // Don't emit anything yet
                    }
                }
            }

            // Check for unmatched strikethrough markers (~~)
            // If there's ~~ in the content but no strikethrough found at that position,
            // it means the structure is incomplete
            if (newPortion.includes('~~')) {
                const hasCompleteStrikethrough = this.hasCompleteStrikethroughAt(inlineTree.rootNode, newPortionStart, newPortionEnd);

                if (!hasCompleteStrikethrough) {
                    // Buffer this content - we have an unmatched ~~
                    this.pendingInlineContent = newContent;
                    this.pendingInlineStartIndex = actualFromIndex;
                    return segments; // Don't emit anything yet
                }
            }
        }

        // Skip empty content
        if (!newContent) return segments;

        // Find the deepest node containing the new content position
        const nodeAtPosition = this.findActiveNodeAtPosition(this.currentTree.rootNode, actualFromIndex);

        if (!nodeAtPosition) {
            // If no node found, treat as plain text
            return [{
                status: "STREAMING",
                segment: {
                    segment: newContent,
                    styles: [],
                    type: "text",
                    isBlockDefining: false,
                    isProcessingNewLine: newContent.includes('\n')
                }
            }];
        }

        // Check if the node is a list marker or table pipe - if so, suppress the content
        // List markers (-, *, +) and table pipes should not be emitted
        const suppressedSyntaxTypes = [
            'list_marker_minus', 'list_marker_plus', 'list_marker_star',
            'list_marker_dot', 'list_marker_parenthesis',
            '|'  // Table pipe delimiters
        ];
        if (suppressedSyntaxTypes.indexOf(nodeAtPosition.type) !== -1) {
            console.log(`[DEBUG] Suppressing syntax marker: "${newContent}"`);
            return segments; // Don't emit syntax markers
        }

        // Check if we're inside a table delimiter row - suppress the entire row
        let currentForDelimiter: Parser.SyntaxNode | null = nodeAtPosition;
        while (currentForDelimiter) {
            if (currentForDelimiter.type === 'pipe_table_delimiter_row' ||
                currentForDelimiter.type === 'pipe_table_delimiter_cell') {
                console.log(`[DEBUG] Suppressing table delimiter: "${newContent}"`);
                return segments; // Don't emit table delimiter content
            }
            currentForDelimiter = currentForDelimiter.parent;
        }

        // Determine the block type and properties using tree-sitter
        const blockInfo = this.getBlockInfo(nodeAtPosition);

        // Check if we're starting a new block
        const isNewBlock = this.isNewBlock(blockInfo, nodeAtPosition);

        // Detect styles in the current context
        const styles = this.detectActiveStyles(nodeAtPosition, actualFromIndex, actualToIndex);

        console.log(`[DEBUG] Content: "${newContent}", styles: [${styles.join(',')}], block: ${blockInfo.type}`);

        // Process content based on block type
        let processedContent = newContent;
        if (blockInfo.type === 'header') {
            // Strip header markers from content using tree-sitter node
            const blockNode = this.findBlockNode(nodeAtPosition);
            processedContent = this.getHeaderContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex);

            // Don't emit if it's only markers (no actual content)
            if (processedContent.length === 0 || processedContent.trim().length === 0) {
                // Update tracking but don't emit segment yet
                if (isNewBlock) {
                    this.currentBlock = {
                        type: blockInfo.type,
                        level: blockInfo.level,
                        language: blockInfo.language,
                        startIndex: nodeAtPosition.startIndex,
                        lastSegmentEnd: actualToIndex,
                        styles: new Set(styles),
                        hasEmittedContent: false
                    };
                } else if (this.currentBlock) {
                    this.currentBlock.lastSegmentEnd = actualToIndex;
                }
                return segments; // Return empty array
            }
        } else if (blockInfo.type === 'codeBlock') {
            // Strip code fence markers (```) from code block content
            const blockNode = this.findBlockNode(nodeAtPosition);
            processedContent = this.getCodeBlockContent(newContent, blockNode || undefined, actualFromIndex, actualToIndex);

            // Don't emit if it's only fence markers
            if (processedContent.length === 0) {
                if (isNewBlock) {
                    this.currentBlock = {
                        type: blockInfo.type,
                        level: blockInfo.level,
                        language: blockInfo.language,
                        startIndex: nodeAtPosition.startIndex,
                        lastSegmentEnd: actualToIndex,
                        styles: new Set(styles),
                        hasEmittedContent: false
                    };
                } else if (this.currentBlock) {
                    this.currentBlock.lastSegmentEnd = actualToIndex;
                }
                return segments;
            }
        } else if (blockInfo.type === 'paragraph') {
            // Suppress paragraphs that are just incomplete header markers
            // This happens when stream sends "####" before tree-sitter can recognize it as a header
            // Check if we're inside a header marker node using tree-sitter node type
            if (nodeAtPosition.type in HEADER_MARKER_LEVELS) {
                // This is likely an incomplete header marker, don't emit it
                return segments; // Return empty array
            }

            // Handle code fence detection in paragraph content
            // This happens when tree-sitter's incremental parsing hasn't recognized content as fenced_code_block yet
            // Check if new content contains a code fence opening ANYWHERE (not just at start)
            const codeFenceOpeningMatch = newContent.match(/```([a-zA-Z0-9]*)\n?/);
            if (codeFenceOpeningMatch) {
                const fenceStart = newContent.indexOf(codeFenceOpeningMatch[0]);
                const fenceLanguage = codeFenceOpeningMatch[1] || '';
                const fenceMarker = codeFenceOpeningMatch[0];

                // Check the full document content from the fence position for closing fence
                const positionOfFence = actualFromIndex + fenceStart;
                const contentFromFence = this.content.substring(positionOfFence);
                const closingFenceIdx = contentFromFence.substring(fenceMarker.length).indexOf('```');

                // Content BEFORE the fence should be emitted as paragraph
                const contentBeforeFence = newContent.substring(0, fenceStart);

                if (closingFenceIdx === -1) {
                    // No closing fence yet - emit content before fence (if any) and buffer the rest
                    if (contentBeforeFence.trim().length > 0) {
                        segments.push({
                            status: "STREAMING",
                            segment: {
                                segment: contentBeforeFence,
                                styles: [],
                                type: 'paragraph',
                                isBlockDefining: false,
                                isProcessingNewLine: contentBeforeFence.includes('\n')
                            }
                        });
                    }

                    // Buffer the fence and content after it
                    const contentFromFenceStart = newContent.substring(fenceStart);
                    console.log(`[DEBUG] Buffering incomplete code block (no close): "${contentFromFenceStart.substring(0, 50)}..."`);
                    this.pendingInlineContent = contentFromFenceStart;
                    this.pendingInlineStartIndex = positionOfFence;
                    return segments;
                } else {
                    // We have a complete code block structure
                    // Emit content before fence as paragraph
                    if (contentBeforeFence.trim().length > 0) {
                        segments.push({
                            status: "STREAMING",
                            segment: {
                                segment: contentBeforeFence,
                                styles: [],
                                type: 'paragraph',
                                isBlockDefining: false,
                                isProcessingNewLine: contentBeforeFence.includes('\n')
                            }
                        });
                    }

                    // Process content after opening fence
                    const contentAfterOpeningFence = newContent.substring(fenceStart + fenceMarker.length);
                    const closingFenceInContent = contentAfterOpeningFence.indexOf('```');

                    let codeContent: string;
                    if (closingFenceInContent === -1) {
                        // Just the opening fence and content, no closing in this chunk
                        codeContent = contentAfterOpeningFence;
                    } else {
                        // Both opening and closing fence in this chunk
                        codeContent = contentAfterOpeningFence.substring(0, closingFenceInContent);
                    }

                    // Strip leading newlines that are part of the fence structure
                    codeContent = codeContent.replace(/^\n/, '');

                    // Emit as code block
                    if (codeContent.length > 0) {
                        console.log(`[DEBUG] Detected code fence in paragraph, reclassifying: "${codeContent.substring(0, 30)}..."`);

                        segments.push({
                            status: "STREAMING",
                            segment: {
                                segment: codeContent,
                                styles: [],
                                type: 'codeBlock',
                                isBlockDefining: true,
                                isProcessingNewLine: codeContent.includes('\n'),
                                language: fenceLanguage
                            }
                        });
                    }

                    // Handle content after closing fence (if present)
                    if (closingFenceInContent !== -1) {
                        const afterClosingFence = contentAfterOpeningFence.substring(closingFenceInContent + 3);
                        const textAfterFence = afterClosingFence.replace(/^\n/, '');
                        if (textAfterFence.trim().length > 0) {
                            segments.push({
                                status: "STREAMING",
                                segment: {
                                    segment: textAfterFence,
                                    styles: [],
                                    type: 'paragraph',
                                    isBlockDefining: true,
                                    isProcessingNewLine: textAfterFence.includes('\n')
                                }
                            });
                        }
                    }

                    return segments;
                }
            }

            // Also check for content in the MIDDLE of a code block
            // This happens when previous chunks contained the opening fence
            // Check if we're currently inside an unclosed code block
            const contentBeforeThis = this.content.substring(0, actualFromIndex);
            const allFences = contentBeforeThis.match(/```/g) || [];
            const isInsideCodeBlock = allFences.length % 2 === 1;

            if (isInsideCodeBlock) {
                // We're inside a code block - check if this content contains closing fence
                const closingFenceIdx = newContent.indexOf('```');

                if (closingFenceIdx === -1) {
                    // No closing fence - emit as code block content
                    console.log(`[DEBUG] Content inside code block: "${newContent.substring(0, 30)}..."`);
                    return [{
                        status: "STREAMING",
                        segment: {
                            segment: newContent,
                            styles: [],
                            type: 'codeBlock',
                            isBlockDefining: false,
                            isProcessingNewLine: newContent.includes('\n')
                        }
                    }];
                } else {
                    // Has closing fence - emit content before fence as code block
                    const codeContent = newContent.substring(0, closingFenceIdx);
                    const afterFence = newContent.substring(closingFenceIdx + 3);

                    if (codeContent.length > 0) {
                        const codeSegment = {
                            status: "STREAMING" as const,
                            segment: {
                                segment: codeContent,
                                styles: [] as string[],
                                type: 'codeBlock',
                                isBlockDefining: false,
                                isProcessingNewLine: codeContent.includes('\n')
                            }
                        };
                        segments.push(codeSegment);
                    }

                    // Handle content after closing fence as paragraph
                    const textAfterFence = afterFence.replace(/^\n/, ''); // Strip leading newline
                    if (textAfterFence.length > 0) {
                        segments.push({
                            status: "STREAMING",
                            segment: {
                                segment: textAfterFence,
                                styles: [],
                                type: 'paragraph',
                                isBlockDefining: true,
                                isProcessingNewLine: textAfterFence.includes('\n')
                            }
                        });
                    }

                    return segments;
                }
            }

        }

        // Now check for inline styles - this applies to ALL block types including headers
        // Skip inline style processing for codeBlock as it doesn't have formatting
        if (blockInfo.type !== 'codeBlock') {
            if (styles.indexOf('code') !== -1) {
                // Strip inline code backticks and potentially split into multiple segments (for prefix/suffix)
                const splitSegments = this.getInlineCodeSegments(processedContent, nodeAtPosition, actualFromIndex, actualToIndex, styles, blockInfo);

                if (splitSegments.length > 0) {
                    // Determine if this block is defining based on whether we've emitted content for it yet
                    let effectiveIsBlockDefining = isNewBlock;
                    if (!isNewBlock && this.currentBlock && !this.currentBlock.hasEmittedContent && this.currentBlock.type === blockInfo.type) {
                        effectiveIsBlockDefining = true;
                    }

                    // If we have segments, push them and update state
                    // Need to apply block defining flag to the FIRST segment
                    splitSegments.forEach((seg, index) => {
                        if (index === 0) seg.segment!.isBlockDefining = effectiveIsBlockDefining;
                        segments.push(seg);
                    });

                    // Update block tracking with the last segment's end (which corresponds to actualToIndex)
                    if (isNewBlock) {
                        this.currentBlock = {
                            type: blockInfo.type,
                            level: blockInfo.level,
                            language: blockInfo.language,
                            startIndex: nodeAtPosition.startIndex,
                            lastSegmentEnd: actualToIndex,
                            styles: new Set(styles),
                            hasEmittedContent: true
                        };
                    } else if (this.currentBlock) {
                        this.currentBlock.lastSegmentEnd = actualToIndex;
                        this.currentBlock.hasEmittedContent = true;
                        styles.forEach(s => this.currentBlock!.styles.add(s));
                    }

                    return segments;
                }
            } else if (styles.indexOf('bold') !== -1) {
                // Strip bold asterisks and potentially split into multiple segments (for prefix/suffix)
                const splitSegments = this.getBoldSegments(processedContent, nodeAtPosition, actualFromIndex, actualToIndex, styles, blockInfo);

                if (splitSegments.length > 0) {
                    // Determine if this block is defining based on whether we've emitted content for it yet
                    let effectiveIsBlockDefining = isNewBlock;
                    if (!isNewBlock && this.currentBlock && !this.currentBlock.hasEmittedContent && this.currentBlock.type === blockInfo.type) {
                        effectiveIsBlockDefining = true;
                    }

                    // If we have segments, push them and update state
                    // Need to apply block defining flag to the FIRST segment
                    splitSegments.forEach((seg, index) => {
                        if (index === 0) seg.segment!.isBlockDefining = effectiveIsBlockDefining;
                        segments.push(seg);
                    });

                    // Update block tracking with the last segment's end (which corresponds to actualToIndex)
                    if (isNewBlock) {
                        this.currentBlock = {
                            type: blockInfo.type,
                            level: blockInfo.level,
                            language: blockInfo.language,
                            startIndex: nodeAtPosition.startIndex,
                            lastSegmentEnd: actualToIndex,
                            styles: new Set(styles),
                            hasEmittedContent: true
                        };
                    } else if (this.currentBlock) {
                        this.currentBlock.lastSegmentEnd = actualToIndex;
                        this.currentBlock.hasEmittedContent = true;
                        styles.forEach(s => this.currentBlock!.styles.add(s));
                    }

                    return segments;
                }
            } else if (styles.indexOf('italic') !== -1) {
                // Strip italic asterisks/underscores and potentially split into multiple segments
                const splitSegments = this.getItalicSegments(processedContent, nodeAtPosition, actualFromIndex, actualToIndex, styles, blockInfo);

                if (splitSegments.length > 0) {
                    // Determine if this block is defining based on whether we've emitted content for it yet
                    let effectiveIsBlockDefining = isNewBlock;
                    if (!isNewBlock && this.currentBlock && !this.currentBlock.hasEmittedContent && this.currentBlock.type === blockInfo.type) {
                        effectiveIsBlockDefining = true;
                    }

                    // If we have segments, push them and update state
                    // Need to apply block defining flag to the FIRST segment
                    splitSegments.forEach((seg, index) => {
                        if (index === 0) seg.segment!.isBlockDefining = effectiveIsBlockDefining;
                        segments.push(seg);
                    });

                    // Update block tracking with the last segment's end (which corresponds to actualToIndex)
                    if (isNewBlock) {
                        this.currentBlock = {
                            type: blockInfo.type,
                            level: blockInfo.level,
                            language: blockInfo.language,
                            startIndex: nodeAtPosition.startIndex,
                            lastSegmentEnd: actualToIndex,
                            styles: new Set(styles),
                            hasEmittedContent: true
                        };
                    } else if (this.currentBlock) {
                        this.currentBlock.lastSegmentEnd = actualToIndex;
                        this.currentBlock.hasEmittedContent = true;
                        styles.forEach(s => this.currentBlock!.styles.add(s));
                    }

                    return segments;
                }
            } else if (styles.indexOf('strikethrough') !== -1) {
                // Strip strikethrough markers and potentially split into multiple segments
                const splitSegments = this.getStrikethroughSegments(processedContent, nodeAtPosition, actualFromIndex, actualToIndex, styles, blockInfo);

                if (splitSegments.length > 0) {
                    // Determine if this block is defining based on whether we've emitted content for it yet
                    let effectiveIsBlockDefining = isNewBlock;
                    if (!isNewBlock && this.currentBlock && !this.currentBlock.hasEmittedContent && this.currentBlock.type === blockInfo.type) {
                        effectiveIsBlockDefining = true;
                    }

                    // If we have segments, push them and update state
                    // Need to apply block defining flag to the FIRST segment
                    splitSegments.forEach((seg, index) => {
                        if (index === 0) seg.segment!.isBlockDefining = effectiveIsBlockDefining;
                        segments.push(seg);
                    });

                    // Update block tracking with the last segment's end (which corresponds to actualToIndex)
                    if (isNewBlock) {
                        this.currentBlock = {
                            type: blockInfo.type,
                            level: blockInfo.level,
                            language: blockInfo.language,
                            startIndex: nodeAtPosition.startIndex,
                            lastSegmentEnd: actualToIndex,
                            styles: new Set(styles),
                            hasEmittedContent: true
                        };
                    } else if (this.currentBlock) {
                        this.currentBlock.lastSegmentEnd = actualToIndex;
                        this.currentBlock.hasEmittedContent = true;
                        styles.forEach(s => this.currentBlock!.styles.add(s));
                    }

                    return segments;
                }
            }
        }

        // Determine if this block is defining based on whether we've emitted content for it yet
        let effectiveIsBlockDefining = isNewBlock;
        if (!isNewBlock && this.currentBlock && !this.currentBlock.hasEmittedContent && this.currentBlock.type === blockInfo.type) {
            effectiveIsBlockDefining = true;
        }

        // Create the segment
        const segment: StreamingChunk = {
            status: "STREAMING",
            segment: {
                segment: processedContent,
                styles: styles,
                type: blockInfo.type,
                isBlockDefining: effectiveIsBlockDefining,
                isProcessingNewLine: newContent.includes('\n'),
                ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
            }
        };

        segments.push(segment);

        // Update current block tracking
        if (isNewBlock) {
            this.currentBlock = {
                type: blockInfo.type,
                level: blockInfo.level,
                language: blockInfo.language,
                startIndex: nodeAtPosition.startIndex,
                lastSegmentEnd: actualToIndex,
                styles: new Set(styles),
                hasEmittedContent: true
            };
        } else if (this.currentBlock) {
            this.currentBlock.lastSegmentEnd = actualToIndex;
            this.currentBlock.hasEmittedContent = true;
            styles.forEach(s => this.currentBlock!.styles.add(s));
        }

        return segments;
    }

    // All other methods remain the same...

    private findActiveNodeAtPosition(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
        // Use exclusive end: position must be strictly less than endIndex
        // This ensures we find nodes that START at position, not ones that END at position
        if (position < node.startIndex || position >= node.endIndex) {
            return null;
        }

        // REMOVED: Do not dive into inline nodes here. 
        // We want to find the deepest node in the BLOCK tree (main tree).
        // Inline nodes (like bold, italic) will be handled by detectActiveStyles.
        // This ensures getBlockInfo always finds the correct block parent in the main tree.

        for (const child of node.children) {
            const childResult = this.findActiveNodeAtPosition(child, position);
            if (childResult) {
                return childResult;
            }
        }

        return node;
    }

    private findNodeInTree(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
        if (position < node.startIndex || position > node.endIndex) {
            return null;
        }

        for (const child of node.children) {
            const result = this.findNodeInTree(child, position);
            if (result) {
                return result;
            }
        }

        return node;
    }

    /**
     * Check if there's a complete code_span that overlaps with the given range
     */
    private hasCompleteCodeSpanAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
        const codeSpans = inlineRoot.descendantsOfType('code_span');
        for (const span of codeSpans) {
            // Check if this code_span overlaps with our range
            if (span.startIndex <= startPos && span.endIndex >= endPos) {
                return true;
            }
            // Also check partial overlap - if our content is inside a code_span
            if (span.startIndex < endPos && span.endIndex > startPos) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if there's a complete strong_emphasis that overlaps with the given range
     */
    private hasCompleteBoldAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
        const strongNodes = inlineRoot.descendantsOfType('strong_emphasis');
        for (const span of strongNodes) {
            // Check if this strong_emphasis overlaps with our range
            if (span.startIndex <= startPos && span.endIndex >= endPos) {
                return true;
            }
            // Also check partial overlap - if our content is inside a strong_emphasis
            if (span.startIndex < endPos && span.endIndex > startPos) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if the text contains an unmatched italic marker (* or _)
     * that is not part of a ** sequence.
     * Uses tree-sitter to detect emphasis_delimiter nodes that aren't matched.
     */
    private hasUnmatchedItalicMarker(text: string): boolean {
        // Use tree-sitter inline parser to check for emphasis markers
        if (this.inlineParser) {
            const inlineTree = this.inlineParser.parse(text);
            if (inlineTree) {
                // Get all emphasis (italic) and strong_emphasis (bold) nodes
                const emphasisNodes = inlineTree.rootNode.descendantsOfType('emphasis');
                const strongNodes = inlineTree.rootNode.descendantsOfType('strong_emphasis');

                // Helper to check if position is inside any matched emphasis or strong node
                const isInsideMatchedNode = (pos: number): boolean => {
                    return emphasisNodes.some(node => pos >= node.startIndex && pos < node.endIndex) ||
                        strongNodes.some(node => pos >= node.startIndex && pos < node.endIndex);
                };

                const textContent = inlineTree.rootNode.text;

                // Check for single * that isn't part of ** and isn't inside a matched node
                for (let i = 0; i < textContent.length; i++) {
                    const char = textContent[i];
                    if (char === '*') {
                        // Check if it's part of ** or ***
                        const prevChar = i > 0 ? textContent[i - 1] : '';
                        const nextChar = i < textContent.length - 1 ? textContent[i + 1] : '';

                        // If this * is adjacent to another *, it's part of ** or ***, skip it
                        if (prevChar === '*' || nextChar === '*') {
                            continue;
                        }

                        // This is a lone *, check if it's inside any emphasis or strong_emphasis node
                        if (!isInsideMatchedNode(i)) {
                            return true;
                        }
                    } else if (char === '_') {
                        // Underscore is a potential italic marker
                        // Check if it's inside a matched node
                        if (!isInsideMatchedNode(i)) {
                            return true;
                        }
                    }
                }

                return false;
            }
        }

        // Fallback: simple character check without regex
        // Check for * that isn't part of **
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '*') {
                const prevChar = i > 0 ? text[i - 1] : '';
                const nextChar = i < text.length - 1 ? text[i + 1] : '';
                if (prevChar !== '*' && nextChar !== '*') {
                    return true; // Lone asterisk found
                }
            } else if (char === '_') {
                return true; // Underscore found
            }
        }

        return false;
    }


    /**
     * Check if there's a complete emphasis that overlaps with the given range
     */
    private hasCompleteItalicAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
        const emphasisNodes = inlineRoot.descendantsOfType('emphasis');
        for (const span of emphasisNodes) {
            // Check if this emphasis overlaps with our range
            if (span.startIndex <= startPos && span.endIndex >= endPos) {
                return true;
            }
            // Also check partial overlap - if our content is inside an emphasis
            if (span.startIndex < endPos && span.endIndex > startPos) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if there's a complete strikethrough that overlaps with the given range
     */
    private hasCompleteStrikethroughAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
        const strikethroughNodes = inlineRoot.descendantsOfType('strikethrough');
        for (const span of strikethroughNodes) {
            // Check if this strikethrough overlaps with our range
            if (span.startIndex <= startPos && span.endIndex >= endPos) {
                return true;
            }
            // Also check partial overlap - if our content is inside a strikethrough
            if (span.startIndex < endPos && span.endIndex > startPos) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if the position is inside a fenced_code_block or code_span (inline code)
     * Used to skip italic buffering inside code contexts where _ is common in variable names
     */
    private isInsideCodeBlock(node: Parser.SyntaxNode, position: number): boolean {
        let current: Parser.SyntaxNode | null = this.findActiveNodeAtPosition(node, position);

        while (current) {
            if (current.type === 'fenced_code_block' || current.type === 'code_fence_content') {
                return true;
            }
            current = current.parent;
        }

        // Also check inline tree for code_span (inline code like `variable_name`)
        if (this.currentTree && this.inlineParser) {
            const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, position);
            if (inlineNode) {
                const inlineContent = inlineNode.text;
                const inlineTree = this.inlineParser.parse(inlineContent);
                const relativePos = position - inlineNode.startIndex;

                // Check if position is inside any code_span
                const codeSpans = inlineTree.rootNode.descendantsOfType('code_span');
                for (const span of codeSpans) {
                    if (relativePos >= span.startIndex && relativePos < span.endIndex) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    private findInlineNodeAtPosition(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
        // If this node is an inline node that contains the position, return it
        if (node.type === 'inline' && position >= node.startIndex && position < node.endIndex) {
            return node;
        }

        // Also check for pipe_table_cell - table cells contain inline content but without 'inline' wrapper
        if (node.type === 'pipe_table_cell' && position >= node.startIndex && position < node.endIndex) {
            return node;
        }

        // Search children
        for (const child of node.children) {
            const result = this.findInlineNodeAtPosition(child, position);
            if (result) {
                return result;
            }
        }

        return null;
    }

    private getBlockInfo(node: Parser.SyntaxNode): { type: string; level?: number; language?: string; id?: number } {
        let current: Parser.SyntaxNode | null = node;
        let foundParagraph = false;
        let foundTableCell = false;
        let isInHeader = false;

        while (current) {
            switch (current.type) {
                case 'atx_heading':
                    return {
                        type: 'header',
                        level: this.getHeadingLevel(current)
                    };
                case 'paragraph':
                    // Don't return immediately - check if we're inside a list_item or blockquote
                    foundParagraph = true;
                    break;
                case 'fenced_code_block':
                    return {
                        type: 'codeBlock',  // Changed from 'code_block' to 'codeBlock' (camelCase)
                        language: this.getCodeBlockLanguage(current)
                    };
                case 'list_item':
                    // If we found a paragraph inside a list_item, return list_item
                    return { type: 'list_item' };
                case 'blockquote':
                    // If we found a paragraph inside a blockquote, return blockquote
                    return { type: 'blockquote' };
                // Table types
                case 'pipe_table_cell':
                    foundTableCell = true;
                    break;
                case 'pipe_table_header':
                    isInHeader = true;
                    // If we found a cell inside a header, return table_header_cell
                    if (foundTableCell) {
                        return { type: 'table_header_cell', id: current.id };
                    }
                    break;
                case 'pipe_table_row':
                    // If we found a cell inside a regular row, return table_cell
                    if (foundTableCell) {
                        return { type: 'table_cell', id: current.id };
                    }
                    break;
                case 'pipe_table':
                    // Found the table - if we have a cell, determine type based on header flag
                    if (foundTableCell) {
                        return { type: isInHeader ? 'table_header_cell' : 'table_cell', id: current.id };
                    }
                    // Otherwise just return table
                    return { type: 'table' };
            }

            current = current.parent;
        }

        // If we found a paragraph but no enclosing list_item/blockquote, return paragraph
        if (foundParagraph) {
            return { type: 'paragraph' };
        }

        return { type: 'paragraph' };
    }

    private isNewBlock(blockInfo: { type: string; level?: number }, node: Parser.SyntaxNode): boolean {
        const blockNode = this.findBlockNode(node);
        if (!blockNode) return false;

        if (!this.currentBlock) return true;

        if (this.currentBlock.type !== blockInfo.type) return true;
        if (blockInfo.level !== undefined && this.currentBlock.level !== blockInfo.level) return true;

        if (blockNode.startIndex > this.currentBlock.lastSegmentEnd) return true;

        return false;
    }

    private findBlockNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
        let current: Parser.SyntaxNode | null = node;
        const blockTypes = [
            'atx_heading', 'paragraph', 'fenced_code_block', 'list_item', 'blockquote',
            'pipe_table', 'pipe_table_header', 'pipe_table_row', 'pipe_table_cell'
        ];

        while (current) {
            if (blockTypes.indexOf(current.type) !== -1) {
                return current;
            }
            current = current.parent;
        }

        return null;
    }

    private detectActiveStyles(node: Parser.SyntaxNode, startIdx: number, endIdx: number): string[] {
        const styles: Set<string> = new Set();
        let current: Parser.SyntaxNode | null = node;

        console.log(`[STYLE] Detecting for ${startIdx}-${endIdx}, starting node: ${node.type}(${node.startIndex}-${node.endIndex})`);

        // First, find the inline node from the BLOCK tree (not the inline tree)
        // to get document-relative positions
        if (this.currentTree) {
            const blockInlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, startIdx);
            if (blockInlineNode && this.inlineParser) {
                const inlineContent = blockInlineNode.text;
                const inlineTree = this.inlineParser.parse(inlineContent);

                console.log(`[STYLE] inline content: "${inlineContent}"`);
                console.log(`[STYLE] inline tree: ${inlineTree?.rootNode.toString()}`);

                if (inlineTree) {
                    // Calculate relative position within the inline content
                    const relativeStart = startIdx - blockInlineNode.startIndex;
                    const relativeEnd = endIdx - blockInlineNode.startIndex;

                    // Check if our range overlaps with any inline style nodes
                    const codeSpans = inlineTree.rootNode.descendantsOfType('code_span');
                    for (const span of codeSpans) {
                        if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                            styles.add('code');
                            break;
                        }
                    }

                    const emphases = inlineTree.rootNode.descendantsOfType('emphasis');
                    for (const span of emphases) {
                        if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                            styles.add('italic');
                            break;
                        }
                    }

                    const strongs = inlineTree.rootNode.descendantsOfType('strong_emphasis');
                    for (const span of strongs) {
                        if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                            styles.add('bold');
                            break;
                        }
                    }

                    const strikethroughs = inlineTree.rootNode.descendantsOfType('strikethrough');
                    for (const span of strikethroughs) {
                        if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                            styles.add('strikethrough');
                            break;
                        }
                    }
                }
            }
        }

        // Walk up the block tree for block-level styles
        while (current) {
            console.log(`[STYLE] Checking node: ${current.type}(${current.startIndex}-${current.endIndex})`);
            if (current.type === 'strong_emphasis' || current.type === 'strong') {
                styles.add('bold');
            } else if (current.type === 'emphasis' || current.type === 'em') {
                styles.add('italic');
            } else if (current.type === 'code_span') {
                styles.add('code');
            } else if (current.type === 'strikethrough') {
                styles.add('strikethrough');
            }
            // Skip inline node processing here - we already handled it above

            current = current.parent;
        }

        return Array.from(styles);
    }

    private getHeadingLevel(node: Parser.SyntaxNode): number {
        // Use tree-sitter node type lookup instead of regex
        for (const child of node.children) {
            const level = HEADER_MARKER_LEVELS[child.type];
            if (level !== undefined) {
                return level;
            }
        }

        // Fallback: count # characters if tree-sitter node not found
        const text = node.text || '';
        let hashCount = 0;
        for (let i = 0; i < text.length && text[i] === '#'; i++) {
            hashCount++;
        }
        if (hashCount >= 1 && hashCount <= 6 && (text[hashCount] === ' ' || text[hashCount] === undefined)) {
            return hashCount;
        }

        return 1;
    }

    private getCodeBlockLanguage(node: Parser.SyntaxNode): string {
        // For fenced_code_block, look for info_string child
        if (node.type === 'fenced_code_block') {
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child && child.type === 'info_string') {
                    return child.text.trim();
                }
            }
        }
        return '';
    }

    private getHeaderContent(content: string, node?: Parser.SyntaxNode, startByte?: number, endByte?: number): string {
        // If we have the tree-sitter node, extract the actual heading content for this chunk
        if (node && node.type === 'atx_heading' && startByte !== undefined && endByte !== undefined) {
            // Find which part of the current chunk overlaps with non-marker content
            let extractedText = '';

            for (const child of node.children) {
                // Skip marker nodes
                if (child.type.startsWith('atx_h') && child.type.endsWith('_marker')) {
                    continue;
                }

                // Check if this child overlaps with our current chunk [startByte, endByte]
                if (child.startIndex < endByte && child.endIndex > startByte) {
                    // Calculate the overlap
                    const overlapStart = Math.max(child.startIndex, startByte);
                    const overlapEnd = Math.min(child.endIndex, endByte);

                    if (overlapStart < overlapEnd) {
                        // Extract just the overlapping portion
                        const relativeStart = overlapStart - startByte;
                        const relativeEnd = overlapEnd - startByte;
                        extractedText += content.substring(relativeStart, relativeEnd);
                    }
                }
            }

            return extractedText;
        }

        throw new Error('Tree-sitter node required for header content extraction');
    }

    private getCodeBlockContent(content: string, node?: Parser.SyntaxNode, startByte?: number, endByte?: number): string {
        // If we have the tree-sitter node, extract code content excluding fence markers
        if (node && node.type === 'fenced_code_block' && startByte !== undefined && endByte !== undefined) {
            let extractedText = '';

            for (const child of node.children) {
                // Skip fence markers and info_string
                if (child.type === 'fenced_code_block_delimiter' || child.type === 'info_string') {
                    continue;
                }

                // Extract code content
                if (child.startIndex < endByte && child.endIndex > startByte) {
                    const overlapStart = Math.max(child.startIndex, startByte);
                    const overlapEnd = Math.min(child.endIndex, endByte);

                    if (overlapStart < overlapEnd) {
                        const relativeStart = overlapStart - startByte;
                        const relativeEnd = overlapEnd - startByte;
                        extractedText += content.substring(relativeStart, relativeEnd);
                    }
                }
            }

            return extractedText;
        }

        throw new Error('Tree-sitter node required for code block content extraction');
    }

    private getInlineCodeSegments(content: string, node: Parser.SyntaxNode, startByte: number, endByte: number, baseStyles: string[], blockInfo: any): StreamingChunk[] {
        console.log(`[GETCODE] content="${content}", startByte=${startByte}, endByte=${endByte}`);

        const segments: StreamingChunk[] = [];

        // Find the inline node that contains this position from the main tree
        if (!this.currentTree) {
            throw new Error('Tree-sitter tree required for inline code segment extraction');
        }

        const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, startByte);

        console.log(`[GETCODE] inlineNode: ${inlineNode?.type}, range: ${inlineNode?.startIndex}-${inlineNode?.endIndex}`);

        // Check for both 'inline' and 'pipe_table_cell'
        if (inlineNode && (inlineNode.type === 'inline' || inlineNode.type === 'pipe_table_cell') && this.inlineParser) {
            const inlineContent = inlineNode.text;
            const inlineTree = this.inlineParser.parse(inlineContent);

            const relativeStart = startByte - inlineNode.startIndex;
            const relativeEnd = endByte - inlineNode.startIndex;

            console.log(`[GETCODE] inlineContent="${inlineContent}", relativeStart=${relativeStart}, relativeEnd=${relativeEnd}`);

            const codeSpans = inlineTree.rootNode.descendantsOfType('code_span');

            // Check if any code span actually overlaps with our range
            let foundOverlap = false;

            for (const codeSpanNode of codeSpans) {
                // Check overlap
                if (codeSpanNode.startIndex < relativeEnd && codeSpanNode.endIndex > relativeStart) {
                    foundOverlap = true;

                    const delimiters = codeSpanNode.children.filter((c: Parser.SyntaxNode) => c.type === 'code_span_delimiter');

                    if (delimiters.length >= 2) {
                        const delimStart = delimiters[0].startIndex;
                        const delimEnd = delimiters[delimiters.length - 1].endIndex;
                        const contentStart = delimiters[0].endIndex;
                        const contentEnd = delimiters[delimiters.length - 1].startIndex;

                        // 1. Prefix (Text before code span)
                        if (delimStart > relativeStart) {
                            const prefixStart = Math.min(delimStart, relativeEnd);
                            const prefixEnd = Math.min(delimStart, relativeEnd);
                            // Wait, logic check: 
                            // We want intersection of [relativeStart, relativeEnd] AND [0, delimStart]
                            const intersectionStart = Math.max(0, relativeStart);
                            const intersectionEnd = Math.min(delimStart, relativeEnd);

                            if (intersectionStart < intersectionEnd) {
                                const prefixText = inlineContent.substring(intersectionStart, intersectionEnd);
                                if (prefixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: prefixText,
                                            styles: baseStyles.filter(s => s !== 'code'), // Remove code style
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: prefixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        // 2. Code Content
                        const codeOverlapStart = Math.max(contentStart, relativeStart);
                        const codeOverlapEnd = Math.min(contentEnd, relativeEnd);

                        if (codeOverlapStart < codeOverlapEnd) {
                            const codeText = inlineContent.substring(codeOverlapStart, codeOverlapEnd);
                            if (codeText) {
                                // Ensure code style is present
                                const codeStyles = [...baseStyles];
                                if (codeStyles.indexOf('code') === -1) codeStyles.push('code');

                                segments.push({
                                    status: "STREAMING",
                                    segment: {
                                        segment: codeText,
                                        styles: codeStyles,
                                        type: blockInfo.type,
                                        isBlockDefining: false, // Middle of chunk is never block defining? Maybe.
                                        isProcessingNewLine: codeText.includes('\n'),
                                        ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                        ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                        ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                    }
                                });
                            }
                        }

                        // 3. Suffix (Text after code span)
                        if (delimEnd < relativeEnd) {
                            const suffixStart = Math.max(delimEnd, relativeStart);
                            const suffixEnd = relativeEnd;

                            if (suffixStart < suffixEnd) {
                                const suffixText = inlineContent.substring(suffixStart, suffixEnd);
                                if (suffixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: suffixText,
                                            styles: baseStyles.filter(s => s !== 'code'), // Remove code style
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: suffixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        return segments;
                    }
                }
            }
        }

        throw new Error('Tree-sitter inline node required for inline code segment extraction');
    }

    private getBoldSegments(content: string, node: Parser.SyntaxNode, startByte: number, endByte: number, baseStyles: string[], blockInfo: any): StreamingChunk[] {
        console.log(`[GETBOLD] content="${content}", startByte=${startByte}, endByte=${endByte}`);

        const segments: StreamingChunk[] = [];

        // Find the inline node that contains this position from the main tree
        if (!this.currentTree) {
            throw new Error('Tree-sitter tree required for bold segment extraction');
        }

        const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, startByte);

        console.log(`[GETBOLD] inlineNode: ${inlineNode?.type}, range: ${inlineNode?.startIndex}-${inlineNode?.endIndex}`);

        // Check for both 'inline' and 'pipe_table_cell'
        if (inlineNode && (inlineNode.type === 'inline' || inlineNode.type === 'pipe_table_cell') && this.inlineParser) {
            const inlineContent = inlineNode.text;
            const inlineTree = this.inlineParser.parse(inlineContent);

            const relativeStart = startByte - inlineNode.startIndex;
            const relativeEnd = endByte - inlineNode.startIndex;

            console.log(`[GETBOLD] inlineContent="${inlineContent}", relativeStart=${relativeStart}, relativeEnd=${relativeEnd}`);

            const strongNodes = inlineTree.rootNode.descendantsOfType('strong_emphasis');

            // Check if any strong_emphasis actually overlaps with our range
            for (const strongNode of strongNodes) {
                // Check overlap
                if (strongNode.startIndex < relativeEnd && strongNode.endIndex > relativeStart) {
                    // Find emphasis_delimiter children (the ** markers)
                    const delimiters = strongNode.children.filter((c: Parser.SyntaxNode) => c.type === 'emphasis_delimiter');

                    console.log(`[GETBOLD] strongNode: ${strongNode.startIndex}-${strongNode.endIndex}, delimiters: ${delimiters.length}`);

                    // For bold (**), we need at least 4 delimiters (2 pairs of *)
                    if (delimiters.length >= 4) {
                        // First two delimiters are the opening **, last two are closing **
                        const openingEnd = delimiters[1].endIndex;
                        const closingStart = delimiters[delimiters.length - 2].startIndex;

                        console.log(`[GETBOLD] openingEnd=${openingEnd}, closingStart=${closingStart}`);

                        // 1. Prefix (Text before bold span)
                        if (strongNode.startIndex > relativeStart) {
                            const intersectionStart = Math.max(0, relativeStart);
                            const intersectionEnd = Math.min(strongNode.startIndex, relativeEnd);

                            if (intersectionStart < intersectionEnd) {
                                const prefixText = inlineContent.substring(intersectionStart, intersectionEnd);
                                if (prefixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: prefixText,
                                            styles: baseStyles.filter(s => s !== 'bold'), // Remove bold style
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: prefixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        // 2. Bold Content (without markers)
                        const boldOverlapStart = Math.max(openingEnd, relativeStart);
                        const boldOverlapEnd = Math.min(closingStart, relativeEnd);

                        if (boldOverlapStart < boldOverlapEnd) {
                            const boldText = inlineContent.substring(boldOverlapStart, boldOverlapEnd);
                            if (boldText) {
                                // Ensure bold style is present
                                const boldStyles = [...baseStyles];
                                if (boldStyles.indexOf('bold') === -1) boldStyles.push('bold');

                                segments.push({
                                    status: "STREAMING",
                                    segment: {
                                        segment: boldText,
                                        styles: boldStyles,
                                        type: blockInfo.type,
                                        isBlockDefining: false,
                                        isProcessingNewLine: boldText.includes('\n'),
                                        ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                        ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                        ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                    }
                                });
                            }
                        }

                        // 3. Suffix (Text after bold span)
                        if (strongNode.endIndex < relativeEnd) {
                            const suffixStart = Math.max(strongNode.endIndex, relativeStart);
                            const suffixEnd = relativeEnd;

                            if (suffixStart < suffixEnd) {
                                const suffixText = inlineContent.substring(suffixStart, suffixEnd);
                                if (suffixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: suffixText,
                                            styles: baseStyles.filter(s => s !== 'bold'), // Remove bold style
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: suffixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        return segments;
                    }
                }
            }
        }

        throw new Error('Tree-sitter inline node required for bold segment extraction');
    }

    private getItalicSegments(content: string, node: Parser.SyntaxNode, startByte: number, endByte: number, baseStyles: string[], blockInfo: any): StreamingChunk[] {
        console.log(`[GETITALIC] content="${content}", startByte=${startByte}, endByte=${endByte}`);

        const segments: StreamingChunk[] = [];

        // Find the inline node that contains this position from the main tree
        if (!this.currentTree) {
            throw new Error('Tree-sitter tree required for italic segment extraction');
        }

        const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, startByte);

        // Check for both 'inline' and 'pipe_table_cell'
        if (inlineNode && (inlineNode.type === 'inline' || inlineNode.type === 'pipe_table_cell') && this.inlineParser) {
            const inlineContent = inlineNode.text;
            const inlineTree = this.inlineParser.parse(inlineContent);

            const relativeStart = startByte - inlineNode.startIndex;
            const relativeEnd = endByte - inlineNode.startIndex;

            const emphasisNodes = inlineTree.rootNode.descendantsOfType('emphasis');

            // Check if any emphasis actually overlaps with our range
            for (const emphasisNode of emphasisNodes) {
                // Check overlap
                if (emphasisNode.startIndex < relativeEnd && emphasisNode.endIndex > relativeStart) {
                    // Find emphasis_delimiter children
                    const delimiters = emphasisNode.children.filter((c: Parser.SyntaxNode) => c.type === 'emphasis_delimiter');

                    // For italic (* or _), we need at least 2 delimiters
                    if (delimiters.length >= 2) {
                        const openingEnd = delimiters[0].endIndex;
                        const closingStart = delimiters[delimiters.length - 1].startIndex;

                        // 1. Prefix (Text before italic span)
                        if (emphasisNode.startIndex > relativeStart) {
                            const intersectionStart = Math.max(0, relativeStart);
                            const intersectionEnd = Math.min(emphasisNode.startIndex, relativeEnd);

                            if (intersectionStart < intersectionEnd) {
                                const prefixText = inlineContent.substring(intersectionStart, intersectionEnd);
                                if (prefixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: prefixText,
                                            styles: baseStyles.filter(s => s !== 'italic'),
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: prefixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        // 2. Italic Content (without markers)
                        const italicOverlapStart = Math.max(openingEnd, relativeStart);
                        const italicOverlapEnd = Math.min(closingStart, relativeEnd);

                        if (italicOverlapStart < italicOverlapEnd) {
                            const italicText = inlineContent.substring(italicOverlapStart, italicOverlapEnd);
                            if (italicText) {
                                const italicStyles = [...baseStyles];
                                if (italicStyles.indexOf('italic') === -1) italicStyles.push('italic');

                                segments.push({
                                    status: "STREAMING",
                                    segment: {
                                        segment: italicText,
                                        styles: italicStyles,
                                        type: blockInfo.type,
                                        isBlockDefining: false,
                                        isProcessingNewLine: italicText.includes('\n'),
                                        ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                        ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                        ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                    }
                                });
                            }
                        }

                        // 3. Suffix (Text after italic span)
                        if (emphasisNode.endIndex < relativeEnd) {
                            const suffixStart = Math.max(emphasisNode.endIndex, relativeStart);
                            const suffixEnd = relativeEnd;

                            if (suffixStart < suffixEnd) {
                                const suffixText = inlineContent.substring(suffixStart, suffixEnd);
                                if (suffixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: suffixText,
                                            styles: baseStyles.filter(s => s !== 'italic'),
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: suffixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        return segments;
                    }
                }
            }
        }

        throw new Error('Tree-sitter inline node required for italic segment extraction');
    }

    private getStrikethroughSegments(content: string, node: Parser.SyntaxNode, startByte: number, endByte: number, baseStyles: string[], blockInfo: any): StreamingChunk[] {
        console.log(`[GETSTRIKETHROUGH] content="${content}", startByte=${startByte}, endByte=${endByte}`);

        const segments: StreamingChunk[] = [];

        // Find the inline node that contains this position from the main tree
        if (!this.currentTree) {
            throw new Error('Tree-sitter tree required for strikethrough segment extraction');
        }

        const inlineNode = this.findInlineNodeAtPosition(this.currentTree.rootNode, startByte);

        // Check for both 'inline' and 'pipe_table_cell'
        if (inlineNode && (inlineNode.type === 'inline' || inlineNode.type === 'pipe_table_cell') && this.inlineParser) {
            const inlineContent = inlineNode.text;
            const inlineTree = this.inlineParser.parse(inlineContent);

            const relativeStart = startByte - inlineNode.startIndex;
            const relativeEnd = endByte - inlineNode.startIndex;

            const strikethroughNodes = inlineTree.rootNode.descendantsOfType('strikethrough');

            // Check if any strikethrough actually overlaps with our range
            // Use only the outermost strikethrough node (first match that overlaps)
            for (const strikethroughNode of strikethroughNodes) {
                // Check overlap
                if (strikethroughNode.startIndex < relativeEnd && strikethroughNode.endIndex > relativeStart) {
                    // Get ALL emphasis_delimiter descendants (including nested ones) sorted by position
                    const delimiters = strikethroughNode.descendantsOfType('emphasis_delimiter')
                        .sort((a: Parser.SyntaxNode, b: Parser.SyntaxNode) => a.startIndex - b.startIndex);

                    console.log(`[GETSTRIKETHROUGH] strikethroughNode: ${strikethroughNode.startIndex}-${strikethroughNode.endIndex}, delimiters: ${delimiters.length}`);
                    delimiters.forEach((d: Parser.SyntaxNode, i: number) => {
                        console.log(`[GETSTRIKETHROUGH]   delimiter ${i}: ${d.startIndex}-${d.endIndex} "${d.text}"`);
                    });

                    // For strikethrough (~~), we need at least 4 delimiters (2 pairs of ~)
                    if (delimiters.length >= 4) {
                        // First two delimiters are the opening ~~, last two are closing ~~
                        const openingEnd = delimiters[1].endIndex;
                        const closingStart = delimiters[delimiters.length - 2].startIndex;

                        console.log(`[GETSTRIKETHROUGH] openingEnd=${openingEnd}, closingStart=${closingStart}`);

                        // 1. Prefix (Text before strikethrough span)
                        if (strikethroughNode.startIndex > relativeStart) {
                            const intersectionStart = Math.max(0, relativeStart);
                            const intersectionEnd = Math.min(strikethroughNode.startIndex, relativeEnd);

                            if (intersectionStart < intersectionEnd) {
                                const prefixText = inlineContent.substring(intersectionStart, intersectionEnd);
                                if (prefixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: prefixText,
                                            styles: baseStyles.filter(s => s !== 'strikethrough'),
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: prefixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        // 2. Strikethrough Content (without markers)
                        const strikethroughOverlapStart = Math.max(openingEnd, relativeStart);
                        const strikethroughOverlapEnd = Math.min(closingStart, relativeEnd);

                        if (strikethroughOverlapStart < strikethroughOverlapEnd) {
                            const strikethroughText = inlineContent.substring(strikethroughOverlapStart, strikethroughOverlapEnd);
                            if (strikethroughText) {
                                const strikethroughStyles = [...baseStyles];
                                if (strikethroughStyles.indexOf('strikethrough') === -1) strikethroughStyles.push('strikethrough');

                                segments.push({
                                    status: "STREAMING",
                                    segment: {
                                        segment: strikethroughText,
                                        styles: strikethroughStyles,
                                        type: blockInfo.type,
                                        isBlockDefining: false,
                                        isProcessingNewLine: strikethroughText.includes('\n'),
                                        ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                        ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                        ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                    }
                                });
                            }
                        }

                        // 3. Suffix (Text after strikethrough span)
                        if (strikethroughNode.endIndex < relativeEnd) {
                            const suffixStart = Math.max(strikethroughNode.endIndex, relativeStart);
                            const suffixEnd = relativeEnd;

                            if (suffixStart < suffixEnd) {
                                const suffixText = inlineContent.substring(suffixStart, suffixEnd);
                                if (suffixText) {
                                    segments.push({
                                        status: "STREAMING",
                                        segment: {
                                            segment: suffixText,
                                            styles: baseStyles.filter(s => s !== 'strikethrough'),
                                            type: blockInfo.type,
                                            isBlockDefining: false,
                                            isProcessingNewLine: suffixText.includes('\n'),
                                            ...(blockInfo.level !== undefined && { level: blockInfo.level }),
                                            ...(blockInfo.language !== undefined && { language: blockInfo.language }),
                                            ...(blockInfo.id !== undefined && { blockId: blockInfo.id })
                                        }
                                    });
                                }
                            }
                        }

                        return segments;
                    }
                }
            }
        }

        throw new Error('Tree-sitter inline node required for strikethrough segment extraction');
    }

    getCurrentContent(): string {
        return this.content;
    }

    getAllSegments(): StreamingChunk[] {
        return this.allSegments;
    }

    getTreeString(): string {
        if (!this.currentTree) return '';
        return this.currentTree.rootNode.toString();
    }

    getSegmentsSummary(): { total: number; byType: Record<string, number> } {
        const byType: Record<string, number> = {};

        this.allSegments.forEach(seg => {
            if (seg.segment) {
                const type = seg.segment.type;
                byType[type] = (byType[type] || 0) + 1;
            }
        });

        return {
            total: this.allSegments.length,
            byType
        };
    }

    reset(): void {
        this.content = '';
        this.currentTree = null;
        this.lastProcessedIndex = 0;
        this.currentBlock = null;
        this.allSegments = [];
    }
}
