import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MarkdownStreamParser, type Chunk, type StreamingChunk } from '../../../../../src/markdown-stream-parser.ts'
import { schema } from './schema.ts'
import { applyStreamingChunkToBuffer, buildDocFromChunks } from './stream-assembly.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = join(__dirname, '../../../../..')
const examplesDir = join(repoRoot, 'demo/svelte-demo/static/llm-streams-examples')
const wasmDir = join(repoRoot, 'demo/svelte-demo/static')

type ParsedExample = {
    chunks: Chunk[]
    activeChunks: Chunk[]
    doc: ReturnType<typeof buildDocFromChunks>
}

function readExampleTokens(name: string): string[] {
    return JSON.parse(readFileSync(join(examplesDir, `${name}.json`), 'utf8')) as string[]
}

async function parseExample(name: string, limit = Number.POSITIVE_INFINITY): Promise<ParsedExample> {
    MarkdownStreamParser.configureWasmPath(join(wasmDir, 'tree-sitter-markdown.wasm'))
    const parser = await MarkdownStreamParser.getInstance(`pm-integration-${name}-${limit}`)
    const chunks: Chunk[] = []
    let activeChunks: Chunk[] = []

    parser.subscribeToTokenParse((parsed: StreamingChunk) => {
        if (parsed.status !== 'STREAMING') return
        chunks.push(parsed.chunk)
        activeChunks = applyStreamingChunkToBuffer(activeChunks, parsed.chunk)
    })

    parser.startParsing()
    for (const token of readExampleTokens(name).slice(0, limit)) {
        parser.parseToken(token)
    }
    parser.stopParsing()
    MarkdownStreamParser.removeInstance(`pm-integration-${name}-${limit}`)

    return {
        chunks,
        activeChunks,
        doc: buildDocFromChunks(schema, activeChunks),
    }
}

function hasNode(doc: ParsedExample['doc'], type: string): boolean {
    let found = false
    doc.descendants(node => {
        if (node.type.name === type) found = true
    })
    return found
}

function hasMark(doc: ParsedExample['doc'], type: string): boolean {
    let found = false
    doc.descendants(node => {
        if (node.marks.some(mark => mark.type.name === type)) found = true
    })
    return found
}

function taskAttrs(doc: ParsedExample['doc']): unknown[] {
    const attrs: unknown[] = []
    doc.descendants(node => {
        if (node.type.name === 'list_item' && node.attrs.task) attrs.push(node.attrs.task)
    })
    return attrs
}

function compactText(text: string): string {
    return text.replace(/\s+/g, '')
}

describe('real stream examples to ProseMirror documents', () => {
    it('renders heading, list, emphasis, and code examples into document structure', async () => {
        const quantum = await parseExample('claude-3.5-1-quantum-physics')
        const history = await parseExample('gpt-4.o-history-of-cats')
        const code = await parseExample('claude-3.7-happy-number-5-programs')

        expect(hasNode(quantum.doc, 'heading')).toBe(true)
        expect(hasNode(history.doc, 'bullet_list') || hasNode(history.doc, 'ordered_list')).toBe(true)
        expect(hasMark(history.doc, 'strong') || hasMark(history.doc, 'em')).toBe(true)
        expect(hasNode(code.doc, 'code_block')).toBe(true)
    })

    it('self-corrects backtracking streams without stale active text', async () => {
        const nestedCode = await parseExample('claude-3.7-markdown-with-nested-code-block')
        const errorRecovery = await parseExample('test-error-recovery')

        expect(nestedCode.chunks.some(chunk => chunk.backtrackOffset !== undefined)).toBe(true)
        expect(errorRecovery.chunks.some(chunk => chunk.backtrackOffset !== undefined)).toBe(true)
        expect(compactText(nestedCode.doc.textContent)).toBe(compactText(nestedCode.activeChunks.map(chunk => chunk.text).join('')))
        expect(compactText(errorRecovery.doc.textContent)).toBe(compactText(errorRecovery.activeChunks.map(chunk => chunk.text).join('')))
        expect(hasNode(errorRecovery.doc, 'table')).toBe(true)
        expect(hasNode(errorRecovery.doc, 'code_block')).toBe(true)
    })

    it('renders strikethrough, tables, and task lists', async () => {
        const strikethrough = await parseExample('test-strikethrough')
        const table = await parseExample('test-error-recovery')
        const taskDoc = buildDocFromChunks(schema, [
            {
                text: 'Completed\n',
                offset: 0,
                length: 10,
                block: { type: 'list_item', list: { type: 'unordered', depth: 0, marker: '-', task: { checked: true } } },
                opening: [],
                closing: [],
                contained: [],
            },
            {
                text: 'Incomplete',
                offset: 10,
                length: 10,
                block: { type: 'list_item', list: { type: 'unordered', depth: 0, marker: '-', task: { checked: false } } },
                opening: [],
                closing: [],
                contained: [],
            },
        ])

        expect(hasMark(strikethrough.doc, 'strikethrough')).toBe(true)
        expect(hasNode(table.doc, 'table')).toBe(true)
        expect(taskAttrs(taskDoc)).toEqual([{ checked: true }, { checked: false }])
    })

    it('supports reset, replay after completion, and switching examples at the buffer level', async () => {
        const partial = await parseExample('gpt-4.5-cat-coding', 5)
        const replayA = await parseExample('test-strikethrough')
        const replayB = await parseExample('test-strikethrough')
        const switched = await parseExample('test-error-recovery', 3)

        expect(partial.activeChunks.length).toBeGreaterThan(0)
        expect(buildDocFromChunks(schema, []).textContent).toBe('')
        expect(replayA.doc.eq(replayB.doc)).toBe(true)
        expect(switched.doc.textContent).not.toBe(partial.doc.textContent)
    })
})
