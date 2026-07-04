import { Parser, Language, type Tree, type Node } from 'web-tree-sitter'
import TokensStreamBuffer from './tokens-stream-buffer.ts'
import type {
    Chunk,
    RecoveryInfo,
    StreamingChunk,
    ParserConfig,
    SegmentGeneratorCheckpoint,
    SegmentGeneratorState
} from './tree-sitter/types.ts'
import { generateSegments, createInitialState, stateFromCheckpoint } from './tree-sitter/segment-generator.ts'
import { mapBlockType } from './tree-sitter/segment-builder.ts'

type RecoverySelection = {
    requiredCheckpoint: SegmentGeneratorCheckpoint
    appliedCheckpoint: SegmentGeneratorCheckpoint
    recovery?: RecoveryInfo
}

// Re-export types for external consumers
export type {
    Span,
    SpanType,
    OpenSpan,
    ClosedSpan,
    BlockType,
    BlockContext,
    Chunk,
    RecoveryInfo,
    StreamingChunk,
    ParserConfig
} from './tree-sitter/types.ts'

// Tree-sitter based streaming markdown parser.
//
// Parses markdown content incrementally as it streams in, detecting:
// - Block types (headers, paragraphs, code blocks, lists, tables, blockquotes)
// - Inline styles (bold, italic, code, strikethrough)
// - Block boundaries and levels
//
// Uses tree-sitter for accurate AST-based parsing with proper handling of
// incomplete structures that may occur during streaming.
export class MarkdownStreamParser {
    // Static singleton management
    private static instances = new Map<string, MarkdownStreamParser>()
    private static parserInitialized = false
    private static parserInitPromise: Promise<void> | null = null
    private static markdownLanguage: Language | null = null
    private static markdownInlineLanguage: Language | null = null
    private static wasmPath: string | null = null
    private static wasmInlinePath: string | null = null

    // Parser instances
    private parser: Parser | null = null
    private inlineParser: Parser | null = null
    private currentTree: Tree | null = null

    // Configuration
    private config: ParserConfig = {}

    // Content state
    private content: string = ''
    private lastProcessedIndex: number = 0
    private endPosition: { row: number; column: number } = { row: 0, column: 0 }
    private allSegments: StreamingChunk[] = []

    // Segment generator state
    private generatorState: SegmentGeneratorState = createInitialState()

    // Integration with TokensStreamBuffer
    private tokensStreamProcessor: TokensStreamBuffer
    private parsing: boolean = false
    private tokenParseListeners: Array<(chunk: StreamingChunk) => void> = []
    private unsubscribeFromProcessor: (() => void) | null = null

    // Configure the WASM file paths before creating any instances.
    // This must be called before getInstance() if you want to use custom paths.
    static configureWasmPath(markdownWasmPath: string, inlineWasmPath?: string): void {
        if (MarkdownStreamParser.parserInitialized) {
            console.warn('WASM path configuration ignored - parser already initialized')
            return
        }
        MarkdownStreamParser.wasmPath = markdownWasmPath
        MarkdownStreamParser.wasmInlinePath = inlineWasmPath || markdownWasmPath.replace('.wasm', '-inline.wasm')
    }

    // Get or create a parser instance with the given ID.
    // instanceId - Unique identifier for the parser instance
    // config - Optional parser configuration
    static async getInstance(instanceId: string, config?: ParserConfig): Promise<MarkdownStreamParser> {
        MarkdownStreamParser.validateConfig(config)

        // Initialize parser and language once for all instances
        if (!MarkdownStreamParser.parserInitialized) {
            if (!MarkdownStreamParser.parserInitPromise) {
                MarkdownStreamParser.parserInitPromise = MarkdownStreamParser.initializeParser()
            }
            await MarkdownStreamParser.parserInitPromise
        }

        if (!MarkdownStreamParser.instances.has(instanceId)) {
            const instance = new MarkdownStreamParser()
            if (config) {
                instance.config = { ...config }
            }
            await instance.initialize()
            MarkdownStreamParser.instances.set(instanceId, instance)
        }

        return MarkdownStreamParser.instances.get(instanceId)!
    }

    // Initialize the tree-sitter parser and load language grammars.
    private static async initializeParser(): Promise<void> {
        try {
            // Initialize the Parser library itself
            await Parser.init({
                locateFile(scriptName: string, scriptDirectory: string) {
                    // In Node.js/test environment, use the configured wasm directory
                    if (typeof window === 'undefined' && MarkdownStreamParser.wasmPath) {
                        const dir = MarkdownStreamParser.wasmPath.substring(0, MarkdownStreamParser.wasmPath.lastIndexOf('/'))
                        return dir + '/' + scriptName
                    }

                    // Browser environment
                    if (typeof window !== 'undefined') {
                        return window.location.origin + '/' + scriptName
                    }

                    // Fallback
                    return '/' + scriptName
                }
            })

            // Determine the correct path based on environment
            let wasmPath = MarkdownStreamParser.wasmPath

            if (!wasmPath) {
                if (typeof window !== 'undefined') {
                    wasmPath = '/tree-sitter-markdown.wasm'
                } else {
                    wasmPath = './wasm/tree-sitter-markdown.wasm'
                }
            }

            MarkdownStreamParser.markdownLanguage = await Language.load(wasmPath)

            // Load the inline language
            let inlineWasmPath = MarkdownStreamParser.wasmInlinePath
            if (!inlineWasmPath) {
                if (typeof window !== 'undefined') {
                    inlineWasmPath = '/tree-sitter-markdown-inline.wasm'
                } else {
                    inlineWasmPath = './wasm/tree-sitter-markdown-inline.wasm'
                }
            }

            MarkdownStreamParser.markdownInlineLanguage = await Language.load(inlineWasmPath)

            MarkdownStreamParser.parserInitialized = true
        } catch (error) {
            console.error('Failed to load tree-sitter-markdown WASM:', error)
            throw new Error(`Failed to initialize markdown parser: ${error}`)
        }
    }

    // Get the WASM path for the current environment.
    private static getWasmPath(): string {
        if (MarkdownStreamParser.wasmPath) {
            return MarkdownStreamParser.wasmPath
        }

        if (typeof window !== 'undefined') {
            return '/tree-sitter-markdown.wasm'
        }

        return './wasm/tree-sitter-markdown.wasm'
    }

    // Remove a parser instance.
    static removeInstance(instanceId: string): void {
        const instance = MarkdownStreamParser.instances.get(instanceId)
        if (instance) {
            instance.stopParsing()
            MarkdownStreamParser.instances.delete(instanceId)
        }
    }

    private static validateConfig(config?: ParserConfig): void {
        if (config?.windowSize === undefined) {
            return
        }

        if (!Number.isFinite(config.windowSize) || config.windowSize < 0) {
            throw new RangeError('windowSize must be a finite number greater than or equal to 0')
        }
    }

    constructor() {
        this.tokensStreamProcessor = new TokensStreamBuffer()
    }

    // Initialize this parser instance with the loaded languages.
    private async initialize(): Promise<void> {
        this.parser = new Parser()
        this.inlineParser = new Parser()

        if (!MarkdownStreamParser.markdownLanguage) {
            throw new Error('Markdown language not loaded. This should not happen if getInstance() was used.')
        }
        if (!MarkdownStreamParser.markdownInlineLanguage) {
            throw new Error('Markdown-inline language not loaded.')
        }

        this.parser.setLanguage(MarkdownStreamParser.markdownLanguage)
        this.inlineParser.setLanguage(MarkdownStreamParser.markdownInlineLanguage)
    }

    // Update parser configuration.
    // config - New parser configuration
    setConfig(config: ParserConfig): void {
        const nextConfig = { ...this.config, ...config }
        MarkdownStreamParser.validateConfig(nextConfig)
        this.config = nextConfig
    }

    // Get current parser configuration.
    getConfig(): ParserConfig {
        return { ...this.config }
    }

    // Subscribe to parsed tokens/segments.
    // Returns an unsubscribe function.
    subscribeToTokenParse(listener: (chunk: StreamingChunk, unsubscribe: () => void) => void): () => void {
        const wrappedListener = (data: StreamingChunk) => {
            listener(data, unsubscribe)
        }

        const unsubscribe = () => {
            this.tokenParseListeners = this.tokenParseListeners.filter(l => l !== wrappedListener)
        }

        this.tokenParseListeners.push(wrappedListener)
        return unsubscribe
    }

    // Notify all subscribers about a parsed token.
    private notifyTokenParse(chunk: StreamingChunk): void {
        this.tokenParseListeners.forEach(listener => listener(chunk))
    }

    // Start the parsing session.
    startParsing(): void {
        if (this.parsing) {
            console.warn('Parser is already running')
            return
        }

        if (!this.parser) {
            throw new Error('Parser not initialized. Call getInstance() to get an initialized instance.')
        }

        this.reset()
        this.notifyTokenParse({ status: 'START_STREAM' })

        this.unsubscribeFromProcessor = this.tokensStreamProcessor.subscribeToSegmentCompletion((word: string) => {
            const segments = this.processRawChunk(word)
            segments.forEach(segment => {
                this.notifyTokenParse(segment)
            })
        })

        this.parsing = true
    }

    // Parse a single token/chunk.
    parseToken(chunk: string): Error | void {
        if (!this.parsing) {
            const error = new Error('Parser is not started. Call startParsing() first.')
            console.error('\x1b[31mMarkdownStreamParser::parseToken::error\x1b[0m', error.message)
            return error
        }

        this.tokensStreamProcessor.receiveChunk(chunk)
    }

    // Stop parsing and cleanup.
    stopParsing(): void {
        if (!this.parsing) {
            return
        }

        this.tokensStreamProcessor.flushBuffer()

        if (this.generatorState.pendingInlineContent) {
            const text = this.generatorState.pendingInlineContent
            const currentBlock = this.generatorState.currentBlock
            const chunk: Chunk = {
                text,
                offset: this.generatorState.totalUtf16Offset,
                length: text.length,
                block: {
                    type: currentBlock ? mapBlockType(currentBlock.type) : 'paragraph',
                    level: currentBlock?.level,
                    language: currentBlock?.language,
                },
                opening: [],
                closing: [],
                contained: [],
                original: this.config.includeRawStreamedToken ? text : undefined,
            }

            this.generatorState = {
                ...this.generatorState,
                totalUtf16Offset: this.generatorState.totalUtf16Offset + text.length,
                lastEmittedOffset: this.generatorState.totalUtf16Offset + text.length,
                lastEmittedSourceOffset: this.generatorState.sourceOffset,
                pendingInlineContent: '',
                pendingInlineStartIndex: undefined,
            }

            const streamingChunk: StreamingChunk = { status: 'STREAMING', chunk }
            this.allSegments.push(streamingChunk)
            this.notifyTokenParse(streamingChunk)
        }

        if (this.unsubscribeFromProcessor) {
            this.unsubscribeFromProcessor()
            this.unsubscribeFromProcessor = null
        }

        this.notifyTokenParse({ status: 'END_STREAM' })

        this.parsing = false
    }

    // Process raw chunk through tree-sitter.
    // Implements incremental parsing with backtrack detection.
    private processRawChunk(chunk: string): StreamingChunk[] {
        if (!this.parser) {
            return []
        }

        const oldLength = this.content.length
        const oldEndPosition = this.endPosition
        this.content += chunk
        this.lastProcessedIndex = this.content.length
        this.endPosition = this.advancePosition(oldEndPosition, chunk)

        const previousTree = this.currentTree

        // For proper incremental parsing, tell tree-sitter what changed
        if (this.currentTree) {
            this.currentTree.edit({
                startIndex: oldLength,
                oldEndIndex: oldLength,
                newEndIndex: this.content.length,
                startPosition: oldEndPosition,
                oldEndPosition,
                newEndPosition: this.endPosition
            })
        }

        // Parse the updated content
        const parsedTree = this.parser.parse(this.content, this.currentTree || undefined)
        if (!parsedTree) {
            return []
        }
        this.currentTree = parsedTree
        const currentTree = this.currentTree

        // Detect backtracking by checking changed source ranges.
        let affectedSourceOffset: number | undefined
        if (previousTree && this.currentTree) {
            const changedRanges = previousTree.getChangedRanges(this.currentTree)

            for (const range of changedRanges) {
                // range.startIndex is already a UTF-16 character offset in web-tree-sitter JS bindings
                // If the change starts before source that produced emitted output, we need to backtrack
                const changeStartUtf16 = range.startIndex

                if (changeStartUtf16 < this.generatorState.lastEmittedSourceOffset) {
                    affectedSourceOffset = Math.min(affectedSourceOffset ?? Infinity, changeStartUtf16)
                }
            }
        }
        previousTree?.delete()

        const errorSourceOffset = this.findEarliestErrorOffset()
        if (errorSourceOffset !== undefined && errorSourceOffset < this.generatorState.lastEmittedSourceOffset) {
            affectedSourceOffset = Math.min(affectedSourceOffset ?? Infinity, errorSourceOffset)
        }

        if (affectedSourceOffset !== undefined) {
            const recoverySelection = this.selectRecoveryCheckpoint(affectedSourceOffset)
            const checkpoint = recoverySelection.appliedCheckpoint
            const priorCheckpoints = this.generatorState.checkpoints
            const preRecoveryLastEmittedOffset = this.generatorState.lastEmittedOffset
            let state: SegmentGeneratorState = stateFromCheckpoint(checkpoint)
            state = {
                ...state,
                checkpoints: this.restoreCheckpointHistory(priorCheckpoints, checkpoint),
            }
            let backtrackOffset = checkpoint.renderedOffset

            // Re-generate all segments from backtrack point through end of content.
            // generateSegments only processes one node per call, so we must loop
            // through word-sized sub-ranges, matching how TokensStreamBuffer drives
            // the parser in the normal path.
            const allBacktrackSegments: StreamingChunk[] = []
            const contentToReprocess = this.content.substring(checkpoint.sourceOffset)
            const wordRanges = this.splitIntoWordRanges(contentToReprocess)

            for (const range of wordRanges) {
                const fromIdx = checkpoint.sourceOffset + range.start
                const toIdx = checkpoint.sourceOffset + range.end
                const result = generateSegments(fromIdx, toIdx, {
                    content: this.content,
                    currentTree,
                    inlineParser: this.inlineParser,
                    state,
                    config: this.config,
                })
                state = result.state
                allBacktrackSegments.push(...result.segments)
            }

            // Update state
            this.generatorState = state

            // Set backtrackOffset on the first re-generated chunk
            if (allBacktrackSegments.length > 0) {
                const firstSeg = allBacktrackSegments[0]
                if (firstSeg.status === 'STREAMING' && firstSeg.chunk) {
                    firstSeg.chunk.backtrackOffset = backtrackOffset
                    firstSeg.chunk.recovery = recoverySelection.recovery
                }
            } else if (backtrackOffset < preRecoveryLastEmittedOffset) {
                allBacktrackSegments.push({
                    status: 'STREAMING',
                    chunk: {
                        text: '',
                        offset: backtrackOffset,
                        length: 0,
                        block: { type: 'paragraph' },
                        opening: [],
                        closing: [],
                        contained: [],
                        backtrackOffset,
                        recovery: recoverySelection.recovery,
                    }
                })
            }

            // Store all segments for debugging
            this.allSegments.push(...allBacktrackSegments)

            return allBacktrackSegments
        }

        // Normal path: no backtracking, generate segments for new content only
        const result = generateSegments(oldLength, this.content.length, {
            content: this.content,
            currentTree,
            inlineParser: this.inlineParser,
            state: this.generatorState,
            config: this.config,
        })

        // Update state
        this.generatorState = result.state

        // Store all segments for debugging
        this.allSegments.push(...result.segments)

        return result.segments
    }

    private selectRecoveryCheckpoint(sourceOffset: number): RecoverySelection {
        const baseCheckpoint: SegmentGeneratorCheckpoint = {
            sourceOffset: 0,
            renderedOffset: 0,
            lastEmittedSourceOffset: 0,
            lastEmittedOffset: 0,
            openSpans: [],
            currentBlock: null,
            pendingInlineContent: '',
        }

        const checkpoints = this.generatorState.checkpoints.length > 0
            ? [baseCheckpoint, ...this.generatorState.checkpoints]
            : [baseCheckpoint]

        let requiredCheckpoint = baseCheckpoint
        for (const candidate of checkpoints) {
            if (candidate.sourceOffset <= sourceOffset && candidate.sourceOffset >= requiredCheckpoint.sourceOffset) {
                requiredCheckpoint = candidate
            }
        }

        if (this.config.windowSize === undefined) {
            return {
                requiredCheckpoint,
                appliedCheckpoint: requiredCheckpoint,
            }
        }

        const windowStart = Math.max(0, this.generatorState.lastEmittedOffset - this.config.windowSize)
        if (requiredCheckpoint.renderedOffset >= windowStart) {
            return {
                requiredCheckpoint,
                appliedCheckpoint: requiredCheckpoint,
            }
        }

        const appliedCheckpoint = checkpoints.find(candidate => candidate.renderedOffset >= windowStart)
            ?? checkpoints[checkpoints.length - 1]

        return {
            requiredCheckpoint,
            appliedCheckpoint,
            recovery: {
                type: 'window_overflow',
                windowSize: this.config.windowSize,
                fullBacktrackOffset: requiredCheckpoint.renderedOffset,
                appliedBacktrackOffset: appliedCheckpoint.renderedOffset,
            },
        }
    }

    private findEarliestErrorOffset(): number | undefined {
        if (!this.currentTree) return undefined

        let earliestConcrete: number | undefined
        let fallback: { offset: number; width: number; depth: number } | undefined

        const visit = (node: Node, depth: number): boolean => {
            if (!node.hasError && !node.isError && !node.isMissing) {
                return false
            }

            if (node.isError || node.isMissing) {
                earliestConcrete = Math.min(earliestConcrete ?? Infinity, node.startIndex)
                return true
            }

            let recordedChild = false
            for (const child of node.children) {
                recordedChild = visit(child, depth + 1) || recordedChild
            }

            if (!recordedChild) {
                const candidate = {
                    offset: node.startIndex,
                    width: node.endIndex - node.startIndex,
                    depth,
                }
                if (
                    !fallback ||
                    candidate.depth > fallback.depth ||
                    (candidate.depth === fallback.depth && candidate.width < fallback.width) ||
                    (candidate.depth === fallback.depth && candidate.width === fallback.width && candidate.offset < fallback.offset)
                ) {
                    fallback = candidate
                }
                return true
            }

            return true
        }

        visit(this.currentTree.rootNode, 0)
        return earliestConcrete ?? fallback?.offset
    }

    private restoreCheckpointHistory(
        priorCheckpoints: SegmentGeneratorCheckpoint[],
        selectedCheckpoint: SegmentGeneratorCheckpoint
    ): SegmentGeneratorCheckpoint[] {
        const checkpoints = priorCheckpoints
            .filter(checkpoint => checkpoint.sourceOffset <= selectedCheckpoint.sourceOffset)

        const selectedIndex = checkpoints.findIndex(checkpoint =>
            checkpoint.sourceOffset === selectedCheckpoint.sourceOffset &&
            checkpoint.renderedOffset === selectedCheckpoint.renderedOffset
        )

        const restored = selectedIndex === -1
            ? [...checkpoints, selectedCheckpoint]
            : checkpoints.map((checkpoint, index) => index === selectedIndex ? selectedCheckpoint : checkpoint)

        return restored.sort((a, b) =>
            a.sourceOffset - b.sourceOffset ||
            a.renderedOffset - b.renderedOffset
        )
    }


    // Split content into word-sized ranges matching TokensStreamBuffer's logic.
    // Each range is { start, end } relative to the input string.
    private splitIntoWordRanges(text: string): Array<{ start: number; end: number }> {
        const ranges: Array<{ start: number; end: number }> = []
        let i = 0

        while (i < text.length) {
            const segmentStart = i

            // Skip leading whitespace
            while (i < text.length && this.isWhitespace(text[i])) {
                i++
            }

            // If only whitespace remains, include it as final range
            if (i >= text.length) {
                if (i > segmentStart) {
                    ranges.push({ start: segmentStart, end: i })
                }
                break
            }

            // Consume non-whitespace (the word)
            while (i < text.length && !this.isWhitespace(text[i])) {
                i++
            }

            // Consume trailing whitespace
            while (i < text.length && this.isWhitespace(text[i])) {
                i++
            }

            ranges.push({ start: segmentStart, end: i })
        }

        return ranges
    }

    private isWhitespace(char: string): boolean {
        return char === ' ' || char === '\t' || char === '\n' || char === '\r'
    }

    private advancePosition(position: { row: number; column: number }, text: string): { row: number; column: number } {
        let row = position.row
        let column = position.column

        for (const char of text) {
            if (char === '\n') {
                row += 1
                column = 0
            } else {
                column += char.length
            }
        }

        return { row, column }
    }

    // Get the current accumulated content.
    getCurrentContent(): string {
        return this.content
    }

    // Get all segments generated so far.
    getAllSegments(): StreamingChunk[] {
        return this.allSegments
    }

    // Get the current tree as a string (for debugging).
    getTreeString(): string {
        if (!this.currentTree) return ''
        return this.currentTree.rootNode.toString()
    }

    // Get a summary of chunks by block type.
    getSegmentsSummary(): { total: number; byType: Record<string, number> } {
        const byType: Record<string, number> = {}

        this.allSegments.forEach(seg => {
            if (seg.status === 'STREAMING' && seg.chunk) {
                const type = seg.chunk.block.type
                byType[type] = (byType[type] || 0) + 1
            }
        })

        return {
            total: this.allSegments.length,
            byType
        }
    }

    // Reset the parser state.
    reset(): void {
        this.content = ''
        this.currentTree?.delete()
        this.currentTree = null
        this.endPosition = { row: 0, column: 0 }
        this.lastProcessedIndex = 0
        this.allSegments = []
        this.generatorState = createInitialState()
    }
}
