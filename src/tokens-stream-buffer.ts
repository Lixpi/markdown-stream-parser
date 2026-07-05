'use strict'

export default class TokensStreamBuffer {
    private _buffer: string
    wordCompleteListeners: Array<(word: string) => void>

    constructor() {
        this._buffer = ''
        this.wordCompleteListeners = []
    }

    public processBufferForCompletion() {
        // Find complete word segments without using regex
        // Original pattern behavior: (\s*\S+\s+|\s*\S+((\n|\\n)+))
        // This means: optional leading whitespace + word + trailing whitespace/newlines
        let lastEmittedIndex = 0
        let i = 0

        while (i < this.buffer.length) {
            // Skip leading whitespace (will be included with the word)
            const segmentStart = i
            while (i < this.buffer.length && this.isWhitespaceChar(this.buffer[i])) {
                i++
            }

            // If we only have whitespace left, stop (don't emit orphan whitespace)
            if (i >= this.buffer.length) {
                break
            }

            // Consume non-whitespace characters (the word)
            while (i < this.buffer.length && !this.isWhitespaceChar(this.buffer[i])) {
                // Check for escaped newline sequence "\\n" within non-whitespace
                if (this.buffer[i] === '\\' && i + 1 < this.buffer.length && this.buffer[i + 1] === 'n') {
                    // Include the escaped newline and emit
                    i += 2
                    const segment = this.buffer.slice(lastEmittedIndex, i)
                    this.notifyWordCompletion(segment)
                    lastEmittedIndex = i
                    // Continue to next iteration
                    break
                }
                i++
            }

            // Check if we broke out due to escaped newline
            if (lastEmittedIndex === i) {
                continue
            }

            // If we're at end of buffer with no trailing whitespace, stop (incomplete word)
            if (i >= this.buffer.length) {
                break
            }

            // Consume ALL trailing whitespace (one or more required for emission)
            const trailingStart = i
            while (i < this.buffer.length && this.isWhitespaceChar(this.buffer[i])) {
                i++
            }

            // Emit the segment: from lastEmittedIndex to end of ALL trailing whitespace
            const segment = this.buffer.slice(lastEmittedIndex, i)
            this.notifyWordCompletion(segment)
            lastEmittedIndex = i
        }

        // Update the buffer by removing the processed part
        if (lastEmittedIndex > 0) {
            this._buffer = this.buffer.slice(lastEmittedIndex)
        }

        // Handle long sequences without whitespace to prevent infinite buffer growth
        const MAX_BUFFER_SIZE = 100
        if (this.buffer.length > MAX_BUFFER_SIZE && !this.hasWhitespace(this.buffer)) {
            const CHUNK_SIZE = 50
            while (this.buffer.length > CHUNK_SIZE) {
                const chunk = this.buffer.slice(0, CHUNK_SIZE)
                this.notifyWordCompletion(chunk)
                this._buffer = this.buffer.slice(CHUNK_SIZE)
            }
        }
    }

    private isWhitespaceChar(char: string): boolean {
        return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\v'
    }

    private hasWhitespace(text: string): boolean {
        for (let i = 0; i < text.length; i++) {
            const char = text[i]
            if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                return true
            }
        }
        return false
    }

    private notifyWordCompletion(word: string) {
        this.wordCompleteListeners.forEach(listener => {
            try {
                listener(word);
            } catch (e) {
                console.error('[TokensStreamBuffer] Listener error for word:', JSON.stringify(word), e);
            }
        });
    }

    public subscribeToSegmentCompletion(listener: (word: string) => void) {
        this.wordCompleteListeners.push(listener)
        return () => this.unsubscribeFromSegmentCompletion(listener)
    }

    public unsubscribeFromSegmentCompletion(listener: (word: string) => void) {
        this.wordCompleteListeners = this.wordCompleteListeners.filter(l => l !== listener)
    }

    // Handle the end of the stream by flushing any remaining content
    public flushBuffer(): void {
        // If there's any content in the buffer that hasn't been emitted, emit it
        if (this.buffer.length > 0) {
            this.notifyWordCompletion(this.buffer)
            this.buffer = ''
        }
    }

    // Use a setter for buffer to trigger word processing upon each chunk addition
    public set buffer(value) {
        this._buffer = value
        this.processBufferForCompletion()
    }

    // Use a getter for buffer to access the current buffer value
    public get buffer() {
        return this._buffer
    }

    public receiveChunk(chunk: string): void {
        if (typeof chunk !== 'string') {
            throw new Error('Chunk must be a string.')
        }

        // Directly set the buffer to trigger the word processing logic
        this.buffer += chunk
    }
}

// Usage:
// const streamProcessor = new TokensStreamProcessor()
// streamProcessor.subscribeToSegmentCompletion(word => console.log(`Word completed: ${word}`))

// Simulating chunks being received:
// streamProcessor.receiveChunk('Hel')
// streamProcessor.receiveChunk('lo ')   // Emits 'Hello'
// streamProcessor.receiveChunk('wor')
// streamProcessor.receiveChunk('ld!\n') // Emits 'world!', then 'Bingo!'
// streamProcessor.receiveChunk('Bingo')
// streamProcessor.receiveChunk('!')
