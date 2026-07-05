import fs from 'fs'
import { MarkdownStreamParser, type StreamingChunk } from '../../src/markdown-stream-parser.ts'

const args = process.argv.slice(2)
let DELAY = 0
let filePath = ''

for (const arg of args) {
    if (arg.startsWith('--interval=')) {
        const val = parseInt(arg.split('=')[1], 10)
        if (!isNaN(val)) DELAY = val
    }
    if (arg.startsWith('--file=')) {
        filePath = arg.split('=')[1]
    }
}

if (!filePath) {
    throw new Error('Missing required argument: --file=<path-to-file>')
}

const sourceFile = `/usr/src/service/${filePath}`

type JSONChunk = string | object

async function* streamJSONinChunks(jsonArray: JSONChunk[]): AsyncGenerator<JSONChunk, void, unknown> {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    for (const item of jsonArray) {
        if (item !== '') {
            yield item
            await delay(DELAY)
        }
    }
}

;(async () => {
    MarkdownStreamParser.configureWasmPath('/usr/src/service/demo/svelte-demo/static/tree-sitter-markdown.wasm')
    const markdownStreamParser = await MarkdownStreamParser.getInstance(filePath)

    const unsubscribe = markdownStreamParser.subscribeToTokenParse((parsed: StreamingChunk, unsubscribe) => {
        console.log('parsed', parsed)

        if (parsed.status === 'END_STREAM') {
            unsubscribe()
        }
    })

    try {
        const jsonContent: string = fs.readFileSync(sourceFile, { encoding: 'utf-8' })
        const parsedJson: JSONChunk[] = JSON.parse(jsonContent)

        markdownStreamParser.startParsing()

        for await (const chunk of streamJSONinChunks(parsedJson)) {
            const chunkStr = typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
            markdownStreamParser.parseToken(chunkStr)
        }

        markdownStreamParser.stopParsing()
    } finally {
        unsubscribe()
        MarkdownStreamParser.removeInstance(filePath)
    }
})()
