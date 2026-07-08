import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import type { Chunk, StreamingChunk } from '../../../../../src/markdown-stream-parser.ts'
import { createEmptyDoc, schema } from './schema.ts'
import { applyStreamingChunkToBuffer, buildDocFromChunks } from './stream-assembly.ts'

export type StreamRenderer = {
    handleStreamingChunk(parsed: StreamingChunk): void
    reset(): void
    destroy(): void
}

export function createStreamRenderer(mount: HTMLElement): StreamRenderer {
    let buffer: Chunk[] = []
    const view = new EditorView(mount, {
        state: EditorState.create({ schema, doc: createEmptyDoc() }),
        editable: () => false,
    })

    function reset(): void {
        buffer = []
        const nextDoc = createEmptyDoc()
        view.updateState(EditorState.create({ schema, doc: nextDoc }))
    }

    return {
        handleStreamingChunk(parsed: StreamingChunk): void {
            if (parsed.status === 'START_STREAM') {
                reset()
                return
            }
            if (parsed.status === 'END_STREAM') return

            const chunk = parsed.chunk
            if (chunk.recovery?.type === 'window_overflow') {
                console.warn('Recovery exceeded windowSize; only the bounded suffix was replaced.', chunk.recovery)
            }

            buffer = applyStreamingChunkToBuffer(buffer, chunk)
            const nextDoc = buildDocFromChunks(schema, buffer)
            if (nextDoc.eq(view.state.doc)) return

            const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, nextDoc.content)
            view.dispatch(tr)
        },
        reset,
        destroy(): void {
            view.destroy()
        },
    }
}
