'use strict'

import TokensStreamBuffer from './tokens-stream-buffer.ts'
import MarkdownStreamParserStateMachine from './state-machine/markdown-state-machine.ts'

export class MarkdownStreamParser {
    static instances = new Map()
    tokensStreamProcessor: TokensStreamBuffer
    markdownStreamParser: MarkdownStreamParserStateMachine
    unsubscribeFromProcessor: () => void
    unsubscribeFromStateMachine: () => void
    parsing: boolean
    tokenParseListeners: Array<(token: any) => void>


    static getInstance(instanceId: string): MarkdownStreamParser {
        if (!MarkdownStreamParser.instances.has(instanceId)) {
            MarkdownStreamParser.instances.set(instanceId, new MarkdownStreamParser())    // Save the instance, ensure it is available statically
        }

        console.info(`\x1b[34mAiStreamParser ->\x1b[0m class.MarkdownStreamParser::\x1b[32mgetInstance\x1b[0m::instanceId: ${instanceId}, instances: ${MarkdownStreamParser.instances}`)

        return MarkdownStreamParser.instances.get(instanceId)
    }

    static removeInstance(instanceId: string): void {
        if (MarkdownStreamParser.instances.has(instanceId)) {
            MarkdownStreamParser.instances.delete(instanceId)
        }
    }

    constructor() {
        this.tokensStreamProcessor = new TokensStreamBuffer()
        this.markdownStreamParser = new MarkdownStreamParserStateMachine()
        this.unsubscribeFromProcessor = () => {}
        this.unsubscribeFromStateMachine = () => {}

        this.parsing = false
        this.tokenParseListeners = []
    }

    // Allow to subscribe to token parse, returns an unsubscribe function
    subscribeToTokenParse(listener: (token: any, unsubscribe: () => void) => void): () => void {
        const wrappedListener = (data: any) => listener(data, unsubscribe)
        const unsubscribe = () => {
            this.tokenParseListeners = this.tokenParseListeners.filter(l => l !== wrappedListener)
        }

        this.tokenParseListeners.push(wrappedListener)

        return unsubscribe    // Allow to unsubscribe from token parse
    }

    // Internal method to notify all token complete listeners
    notifyTokenParse(token: any): void {
        this.tokenParseListeners.forEach(listener => listener(token))
    }

    // Start parsing by subscribing to the TokensStreamBuffer's word completion event
    startParsing(): void {
        if (this.parsing) {
            return // Do not start parsing if it's already started
        }

        this.notifyTokenParse({status: 'START_STREAM'})

        // Subscribe to receive the completed segment from TokensStreamBuffer
        this.unsubscribeFromProcessor = this.tokensStreamProcessor.subscribeToSegmentCompletion((word: string) => {
            // console.log('class.MarkdownStreamParser::subscribeToSegmentCompletion::word:', {word})
            this.markdownStreamParser.parseSegment(word)     // Send the word to the state machine for parsing
        })

        // Subscribe to receive the parsed segment from TextStreamStateMachine
        this.unsubscribeFromStateMachine = this.markdownStreamParser.subscribeToParsedSegment((parsedSegment: any) => {
            this.notifyTokenParse({status: 'STREAMING', segment: parsedSegment}) // Relay the parsed segment event
        })

        this.parsing = true
    }

    // Parse individual chunk token
    parseToken(chunk: string): Error | void {
        if (!this.parsing) {
            const error = new Error('Parser is not started.')
            console.info(`\x1b[34mAiStreamParser ->\x1b[0m \x1b[31mclass.MarkdownStreamParser::parseToken::error\x1b[0m`, error)

            return error
        }

        this.tokensStreamProcessor.receiveChunk(chunk)
    }

    // Stop parsing by unsubscribing from the TokensStreamBuffer
    stopParsing(): void {
        this.tokensStreamProcessor.flushBuffer()    // Flush any remaining content
        this.markdownStreamParser.resetParser()    // Reset the state machine
        this.unsubscribeFromProcessor()    // Unsubscribe from the processor
        this.unsubscribeFromStateMachine()    // Unsubscribe from the state machine
        this.parsing = false    // Mark as not parsing
        this.notifyTokenParse({status: 'END_STREAM'})    // Notify that the stream has ended
    }
}

