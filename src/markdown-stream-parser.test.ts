import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownStreamParser, type Chunk } from './markdown-stream-parser'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const wasmDir = path.join(__dirname, '../demo/svelte-demo/static')

describe('MarkdownStreamParser public entrypoint', () => {
  const instanceId = 'test-public-entrypoint'
  let parser: MarkdownStreamParser
  let parsedChunks: Chunk[]

  beforeEach(async () => {
    parsedChunks = []
    MarkdownStreamParser.configureWasmPath(path.join(wasmDir, 'tree-sitter-markdown.wasm'))
    parser = await MarkdownStreamParser.getInstance(instanceId)
    parser.subscribeToTokenParse((chunk) => {
      if (chunk.status === 'STREAMING') {
        parsedChunks.push(chunk.chunk)
      }
    })
  })

  afterEach(() => {
    parser.stopParsing()
    MarkdownStreamParser.removeInstance(instanceId)
  })

  it('returns the same async parser instance for a given instanceId', async () => {
    const parser2 = await MarkdownStreamParser.getInstance(instanceId)
    expect(parser2).toBe(parser)
  })

  it('creates different parser instances for different instanceIds', async () => {
    const other = await MarkdownStreamParser.getInstance('test-public-entrypoint-other')
    expect(other).not.toBe(parser)
    MarkdownStreamParser.removeInstance('test-public-entrypoint-other')
  })

  it('parses through the tree-sitter chunk API', () => {
    parser.startParsing()
    parser.parseToken('## ')
    parser.parseToken('Hello **world**\n')
    parser.stopParsing()

    const text = parsedChunks.map(chunk => chunk.text).join('')
    expect(text).toContain('Hello world')
    expect(text).not.toContain('##')
    expect(text).not.toContain('**')
    expect(parsedChunks.some(chunk => chunk.block.type === 'heading')).toBe(true)
    expect(parsedChunks.some(chunk => chunk.contained.some(span => span.type === 'bold'))).toBe(true)
  })

  it('returns an error if parseToken is called before startParsing', () => {
    const error = parser.parseToken('chunk')
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('Parser is not started. Call startParsing() first.')
  })
})
