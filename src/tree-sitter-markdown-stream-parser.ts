import { Parser, Language } from 'web-tree-sitter'
import TokensStreamBuffer from './tokens-stream-buffer.js'
import type { StreamingChunk, BlockState, ParserConfig, SegmentGeneratorState, Chunk } from './tree-sitter/types.js'
import { generateSegments, createInitialState } from './tree-sitter/segment-generator.js'
import { utf16ToByteOffset } from './tree-sitter/segment-builder.js'

// Re-export types for external consumers
export type {
    Span,
    SpanType,
    OpenSpan,
    ClosedSpan,
    BlockType,
    BlockContext,
    Chunk,
    StreamingChunk,
    ParserConfig
} from './tree-sitter/types.js'

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
    private static markdownLanguage: Parser.Language | null = null
    private static markdownInlineLanguage: Parser.Language | null = null
    private static wasmPath: string | null = null
    private static wasmInlinePath: string | null = null

    // Parser instances
    private parser: Parser | null = null
    private inlineParser: Parser | null = null
    private currentTree: Parser.Tree | null = null
    private previousTree: Parser.Tree | null = null

    // Configuration
    private config: ParserConfig = {}

    // Content state
    private content: string = ''
    private lastProcessedIndex: number = 0
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
                instance.config = config
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
        this.config = { ...this.config, ...config }
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
        this.content += chunk
        this.lastProcessedIndex = this.content.length

        // Store previous tree for change detection
        this.previousTree = this.currentTree

        // For proper incremental parsing, tell tree-sitter what changed
        if (this.currentTree) {
            const getPosition = (index: number) => {
                const textUpToIndex = this.content.substring(0, Math.min(index, this.content.length))
                const lines = textUpToIndex.split('\n')
                return {
                    row: lines.length - 1,
                    column: lines[lines.length - 1].length
                }
            }

            this.currentTree.edit({
                startIndex: oldLength,
                oldEndIndex: oldLength,
                newEndIndex: this.content.length,
                startPosition: getPosition(oldLength),
                oldEndPosition: getPosition(oldLength),
                newEndPosition: getPosition(this.content.length)
            })
        }

        // Parse the updated content
        this.currentTree = this.parser.parse(this.content, this.currentTree || undefined)

        // Detect backtracking by checking changed ranges
        let backtrackOffset: number | undefined
        if (this.previousTree && this.currentTree) {
            const changedRanges = this.previousTree.getChangedRanges(this.currentTree)

            for (const range of changedRanges) {
                // Convert byte offset to UTF-16 offset for the backtrack position
                // If the change starts before what we've emitted, we need to backtrack
                const changeStartUtf16 = this.byteToUtf16(range.startIndex)

                if (changeStartUtf16 < this.generatorState.lastEmittedOffset) {
                    // Check windowSize constraint
                    const backtrackDistance = this.generatorState.lastEmittedOffset - changeStartUtf16

                    if (this.config.windowSize === undefined || backtrackDistance <= this.config.windowSize) {
                        // Backtrack is within window
                        backtrackOffset = Math.min(backtrackOffset ?? Infinity, changeStartUtf16)
                    } else {
                        // Backtrack exceeds window - best effort
                        // Set backtrack to the edge of the window
                        const windowStart = this.generatorState.lastEmittedOffset - this.config.windowSize
                        backtrackOffset = Math.min(backtrackOffset ?? Infinity, windowStart)
                    }
                }
            }
        }

        if (backtrackOffset !== undefined) {
            // Error recovery: re-generate segments from the backtrack point
            // Convert UTF-16 backtrack offset to byte offset for generateSegments
            const backtrackByteOffset = utf16ToByteOffset(this.content, backtrackOffset)

            // Reset generator state to the backtrack point
            const resetState: SegmentGeneratorState = {
                totalUtf16Offset: backtrackOffset,
                lastEmittedOffset: backtrackOffset,
                openSpans: [],
                currentBlock: null,
                pendingInlineContent: '',
                accumulatedContent: this.content.substring(0, backtrackByteOffset),
            }

            // Re-generate all segments from backtrack point through end of content
            const result = generateSegments(backtrackByteOffset, this.content.length, {
                content: this.content,
                currentTree: this.currentTree,
                inlineParser: this.inlineParser,
                state: resetState,
                config: this.config,
            })

            // Update state
            this.generatorState = result.state

            // Set backtrackOffset on the first re-generated chunk
            if (result.segments.length > 0) {
                const firstSeg = result.segments[0]
                if (firstSeg.status === 'STREAMING' && firstSeg.chunk) {
                    firstSeg.chunk.backtrackOffset = backtrackOffset
                }
            }

            // Store all segments for debugging
            this.allSegments.push(...result.segments)

            return result.segments
        }

        // Normal path: no backtracking, generate segments for new content only
        const result = generateSegments(oldLength, this.content.length, {
            content: this.content,
            currentTree: this.currentTree,
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

    // Convert byte offset to UTF-16 code unit offset.
    private byteToUtf16(byteOffset: number): number {
        const encoder = new TextEncoder()
        let utf16Offset = 0
        let currentByteOffset = 0

        for (const char of this.content) {
            if (currentByteOffset >= byteOffset) break
            const charBytes = encoder.encode(char).length
            currentByteOffset += charBytes
            utf16Offset += char.length
        }

        return utf16Offset
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
        this.currentTree = null
        this.previousTree = null
        this.lastProcessedIndex = 0
        this.allSegments = []
        this.generatorState = createInitialState()
    }
}
