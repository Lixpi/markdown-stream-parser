import { Parser, Language } from 'web-tree-sitter'
import TokensStreamBuffer from './tokens-stream-buffer.js'
import {
    type StreamingChunk,
    type BlockState,
    generateSegments,
    type SegmentGeneratorState,
} from './tree-sitter/index.js'

// Re-export types for external consumers
export type { StreamingSegment, StreamingChunk } from './tree-sitter/index.js'

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

    // Content state
    private content: string = ''
    private lastProcessedIndex: number = 0
    private allSegments: StreamingChunk[] = []

    // Segment generator state
    private generatorState: SegmentGeneratorState = {
        pendingInlineContent: '',
        pendingInlineStartIndex: 0,
        currentBlock: null,
    }

    // Integration with TokensStreamBuffer
    private tokensStreamProcessor: TokensStreamBuffer
    private parsing: boolean = false
    private tokenParseListeners: Array<(chunk: StreamingChunk) => void> = []
    private unsubscribeFromProcessor: (() => void) | null = null

    /**
     * Configure the WASM file paths before creating any instances.
     * This must be called before getInstance() if you want to use custom paths.
     */
    static configureWasmPath(markdownWasmPath: string, inlineWasmPath?: string): void {
        if (MarkdownStreamParser.parserInitialized) {
            console.warn('WASM path configuration ignored - parser already initialized')
            return
        }
        MarkdownStreamParser.wasmPath = markdownWasmPath
        MarkdownStreamParser.wasmInlinePath = inlineWasmPath || markdownWasmPath.replace('.wasm', '-inline.wasm')
    }

    /**
     * Get or create a parser instance with the given ID.
     */
    static async getInstance(instanceId: string): Promise<MarkdownStreamParser> {
        // Initialize parser and language once for all instances
        if (!MarkdownStreamParser.parserInitialized) {
            if (!MarkdownStreamParser.parserInitPromise) {
                MarkdownStreamParser.parserInitPromise = MarkdownStreamParser.initializeParser()
            }
            await MarkdownStreamParser.parserInitPromise
        }

        if (!MarkdownStreamParser.instances.has(instanceId)) {
            const instance = new MarkdownStreamParser()
            await instance.initialize()
            MarkdownStreamParser.instances.set(instanceId, instance)
        }

        console.info(`\x1b[34mMarkdownStreamParser ->\x1b[0m getInstance::instanceId: ${instanceId}`)
        return MarkdownStreamParser.instances.get(instanceId)!
    }

    /**
     * Initialize the tree-sitter parser and load language grammars.
     */
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

            console.info(`Loading markdown WASM from: ${wasmPath}`)
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

            console.info(`Loading markdown-inline WASM from: ${inlineWasmPath}`)
            MarkdownStreamParser.markdownInlineLanguage = await Language.load(inlineWasmPath)

            MarkdownStreamParser.parserInitialized = true
            console.info('✅ Tree-sitter markdown language loaded successfully')
            console.info('✅ Tree-sitter markdown-inline language loaded successfully')
        } catch (error) {
            console.error('Failed to load tree-sitter-markdown WASM:', error)
            throw new Error(`Failed to initialize markdown parser: ${error}`)
        }
    }

    /**
     * Get the WASM path for the current environment.
     */
    private static getWasmPath(): string {
        if (MarkdownStreamParser.wasmPath) {
            return MarkdownStreamParser.wasmPath
        }

        if (typeof window !== 'undefined') {
            return '/tree-sitter-markdown.wasm'
        }

        return './wasm/tree-sitter-markdown.wasm'
    }

    /**
     * Remove a parser instance.
     */
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

    /**
     * Initialize this parser instance with the loaded languages.
     */
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

        console.info('Parser instance initialized with markdown and markdown-inline languages')
    }

    /**
     * Subscribe to parsed tokens/segments.
     * Returns an unsubscribe function.
     */
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

    /**
     * Notify all subscribers about a parsed token.
     */
    private notifyTokenParse(chunk: StreamingChunk): void {
        this.tokenParseListeners.forEach(listener => listener(chunk))
    }

    /**
     * Start the parsing session.
     */
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
        console.info('\x1b[32mParser started\x1b[0m')
    }

    /**
     * Parse a single token/chunk.
     */
    parseToken(chunk: string): Error | void {
        if (!this.parsing) {
            const error = new Error('Parser is not started. Call startParsing() first.')
            console.error('\x1b[31mMarkdownStreamParser::parseToken::error\x1b[0m', error.message)
            return error
        }

        this.tokensStreamProcessor.receiveChunk(chunk)
    }

    /**
     * Stop parsing and cleanup.
     */
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
        console.info('\x1b[32mParser stopped\x1b[0m')
    }

    /**
     * Process raw chunk through tree-sitter.
     */
    private processRawChunk(chunk: string): StreamingChunk[] {
        if (!this.parser) {
            return []
        }

        const oldLength = this.content.length
        this.content += chunk
        this.lastProcessedIndex = this.content.length

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

        // Generate segments using the refactored module
        const result = generateSegments(oldLength, this.content.length, {
            content: this.content,
            currentTree: this.currentTree,
            inlineParser: this.inlineParser,
            state: this.generatorState,
        })

        // Update state
        this.generatorState = result.state

        // Store all segments for debugging
        this.allSegments.push(...result.segments)

        return result.segments
    }

    /**
     * Get the current accumulated content.
     */
    getCurrentContent(): string {
        return this.content
    }

    /**
     * Get all segments generated so far.
     */
    getAllSegments(): StreamingChunk[] {
        return this.allSegments
    }

    /**
     * Get the current tree as a string (for debugging).
     */
    getTreeString(): string {
        if (!this.currentTree) return ''
        return this.currentTree.rootNode.toString()
    }

    /**
     * Get a summary of segments by type.
     */
    getSegmentsSummary(): { total: number; byType: Record<string, number> } {
        const byType: Record<string, number> = {}

        this.allSegments.forEach(seg => {
            if (seg.segment) {
                const type = seg.segment.type
                byType[type] = (byType[type] || 0) + 1
            }
        })

        return {
            total: this.allSegments.length,
            byType
        }
    }

    /**
     * Reset the parser state.
     */
    reset(): void {
        this.content = ''
        this.currentTree = null
        this.lastProcessedIndex = 0
        this.allSegments = []
        this.generatorState = {
            pendingInlineContent: '',
            pendingInlineStartIndex: 0,
            currentBlock: null,
        }
    }
}
