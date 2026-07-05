import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MarkdownStreamParser } from './tree-sitter-markdown-stream-parser'
import type { Chunk, ClosedSpan, SpanType, StreamingChunk } from './tree-sitter/types.ts'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Helper to check if a chunk has a span of the given type
function hasSpanType(chunk: Chunk, type: SpanType): boolean {
  const allSpans = [...chunk.contained, ...chunk.closing]
  return allSpans.some(span => span.type === type)
}

// Helper to get all span types from a chunk
function getSpanTypes(chunk: Chunk): SpanType[] {
  const allSpans = [...chunk.opening, ...chunk.closing, ...chunk.contained] as ClosedSpan[]
  return allSpans.map(span => span.type)
}

function getClosedSpans(chunks: Chunk[]): ClosedSpan[] {
  return chunks.flatMap(c => [...c.contained, ...c.closing])
}

function applyBacktracks(chunks: Chunk[]): Chunk[] {
  let activeChunks: Chunk[] = []

  for (const chunk of chunks) {
    if (chunk.backtrackOffset !== undefined) {
      activeChunks = activeChunks.filter(c => c.offset + c.length <= chunk.backtrackOffset!)
    }
    activeChunks.push(chunk)
  }

  return activeChunks
}

function processRawChunk(parser: MarkdownStreamParser, chunk: string): StreamingChunk[] {
  return (parser as unknown as { processRawChunk(chunk: string): StreamingChunk[] }).processRawChunk(chunk)
}

function processRawAndCollect(parser: MarkdownStreamParser, chunk: string, chunks: Chunk[]): void {
  for (const segment of processRawChunk(parser, chunk)) {
    if (segment.status === 'STREAMING') {
      chunks.push(segment.chunk)
    }
  }
}

describe('Tree-Sitter MarkdownStreamParser - Phase 1: Quick Wins', () => {
  let parser: MarkdownStreamParser
  let parsedChunks: Chunk[] = []
  const instanceId = 'test-tree-sitter'

  // Set up path for WASM files
  const wasmDir = path.join(__dirname, '../demo/svelte-demo/static')

  beforeEach(async () => {
    parsedChunks = []

    // Configure WASM path for testing - this will also help locateFile find tree-sitter.wasm
    MarkdownStreamParser.configureWasmPath(path.join(wasmDir, 'tree-sitter-markdown.wasm'))

    parser = await MarkdownStreamParser.getInstance(instanceId)

    parser.subscribeToTokenParse((chunk) => {
      if (chunk.status === 'STREAMING' && chunk.chunk) {
        parsedChunks.push(chunk.chunk)
      }
    })

    parser.startParsing()
  })

  afterEach(() => {
    parser.stopParsing()
    MarkdownStreamParser.removeInstance(instanceId)
  })

  describe('Basic Block Types', () => {
    it('should use snake_case for block type names (new API)', async () => {
      parser.parseToken('```javascript\n')
      parser.parseToken('code\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      expect(codeBlockChunks.length).toBeGreaterThan(0)
    })

    it('should extract language from code blocks', async () => {
      parser.parseToken('```javascript\n')
      parser.parseToken('const x = 1;\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      expect(codeBlockChunks.length).toBeGreaterThan(0)

      // Should have language field
      const hasLanguage = codeBlockChunks.some(c => c.block.language === 'javascript')
      expect(hasLanguage).toBe(true)
    })

    it('should handle code blocks without language', async () => {
      parser.parseToken('```\n')
      parser.parseToken('code\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      expect(codeBlockChunks.length).toBeGreaterThan(0)

      // Language should be empty string or undefined
      const firstCodeBlock = codeBlockChunks[0]
      expect(firstCodeBlock.block.language === '' || firstCodeBlock.block.language === undefined).toBe(true)
    })
  })

  describe('Header Processing', () => {
    it('should strip header markers from content', async () => {
      parser.parseToken('## ')
      parser.parseToken('Header Text\n')
      parser.stopParsing()

      const headerChunks = parsedChunks.filter(c => c.block.type === 'heading')
      expect(headerChunks.length).toBeGreaterThan(0)

      // Content should NOT include ##
      const headerContent = headerChunks.map(c => c.text).join('')
      expect(headerContent).not.toContain('##')
      expect(headerContent.trim()).toBe('Header Text')
    })

    it('should detect all 6 header levels correctly', async () => {
      const levels = [1, 2, 3, 4, 5, 6]

      for (const level of levels) {
        parsedChunks = []
        parser = await MarkdownStreamParser.getInstance(`test-${level}`)
        parser.subscribeToTokenParse((chunk) => {
          if (chunk.status === 'STREAMING' && chunk.chunk) {
            parsedChunks.push(chunk.chunk)
          }
        })
        parser.startParsing()

        const markers = '#'.repeat(level)
        parser.parseToken(`${markers} `)
        parser.parseToken(`Level ${level}\n`)
        parser.stopParsing()

        const headerChunks = parsedChunks.filter(c => c.block.type === 'heading')
        expect(headerChunks.length).toBeGreaterThan(0)
        expect(headerChunks[0].block.level).toBe(level)

        MarkdownStreamParser.removeInstance(`test-${level}`)
      }
    })

    it('should handle multiple headers in sequence', async () => {
      parser.parseToken('# First\n')
      parser.parseToken('## Second\n')
      parser.parseToken('### Third\n')
      parser.stopParsing()

      const headerChunks = parsedChunks.filter(c => c.block.type === 'heading')
      expect(headerChunks.length).toBeGreaterThan(0)

      // Check that content doesn't include markers
      headerChunks.forEach(chunk => {
        expect(chunk.text).not.toMatch(/^#+\s/)
      })
    })
  })

  describe('Blockquotes', () => {
    // TODO: Blockquote marker stripping is not yet implemented in the parser.
    // These tests document the expected behavior for future implementation.
    // Currently, blockquote content is returned as 'paragraph' type with markers included.

    it.skip('should detect blockquote type correctly', async () => {
      parser.parseToken('> This is a quote\n')
      parser.stopParsing()

      const blockquoteChunks = parsedChunks.filter(c => c.block.type === 'blockquote')
      expect(blockquoteChunks.length).toBeGreaterThan(0)
    })

    it.skip('should strip blockquote marker from content', async () => {
      parser.parseToken('> Quoted text\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      // Should not contain the > marker
      expect(fullText).not.toMatch(/^>/)
      expect(fullText).toContain('Quoted text')
    })

    it.skip('should handle multiline blockquotes', async () => {
      parser.parseToken('> Line one\n')
      parser.parseToken('> Line two\n')
      parser.stopParsing()

      const blockquoteChunks = parsedChunks.filter(c => c.block.type === 'blockquote')
      expect(blockquoteChunks.length).toBeGreaterThan(0)

      const fullText = blockquoteChunks.map(c => c.text).join('')
      expect(fullText).toContain('Line one')
      expect(fullText).toContain('Line two')
    })

    it.skip('should handle nested blockquotes', async () => {
      parser.parseToken('> Outer quote\n')
      parser.parseToken('>> Nested quote\n')
      parser.stopParsing()

      const blockquoteChunks = parsedChunks.filter(c => c.block.type === 'blockquote')
      expect(blockquoteSegments.length).toBeGreaterThan(0)
    })
  })

  describe('List Items', () => {
    it('should detect unordered list items', async () => {
      parser.parseToken('- First item\n')
      parser.parseToken('- Second item\n')
      parser.stopParsing()

      const listChunks = parsedChunks.filter(c => c.block.type === 'list_item')
      expect(listChunks.length).toBeGreaterThan(0)
    })

    it('should strip list markers from content', async () => {
      parser.parseToken('- List content\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      // Should not contain the - marker at start
      expect(fullText).not.toMatch(/^-\s/)
      expect(fullText).toContain('List content')
    })

    it('should detect ordered list items', async () => {
      parser.parseToken('1. First\n')
      parser.parseToken('2. Second\n')
      parser.stopParsing()

      const listChunks = parsedChunks.filter(c => c.block.type === 'list_item')
      expect(listChunks.length).toBeGreaterThan(0)
    })

    it('should handle nested list items', async () => {
      parser.parseToken('- Parent\n')
      parser.parseToken('  - Child\n')
      parser.stopParsing()

      const listChunks = parsedChunks.filter(c => c.block.type === 'list_item')
      expect(listChunks.length).toBeGreaterThan(0)
    })

    it('should handle asterisk list markers', async () => {
      parser.parseToken('* Item one\n')
      parser.parseToken('* Item two\n')
      parser.stopParsing()

      const listChunks = parsedChunks.filter(c => c.block.type === 'list_item')
      expect(listChunks.length).toBeGreaterThan(0)
    })
  })

  describe('Nested Inline Styles', () => {
    it('should detect bold inside italic', async () => {
      parser.parseToken('This is *italic with **bold** inside*\n')
      parser.stopParsing()

      const boldChunks = parsedChunks.filter(c => hasSpanType(c, 'bold'))
      const italicChunks = parsedChunks.filter(c => hasSpanType(c, 'italic'))

      expect(italicChunks.length).toBeGreaterThan(0)
      expect(boldChunks.length).toBeGreaterThan(0)
    })

    it('should detect italic inside bold', async () => {
      parser.parseToken('This is **bold with *italic* inside**\n')
      parser.stopParsing()

      const boldChunks = parsedChunks.filter(c => hasSpanType(c, 'bold'))
      const italicChunks = parsedChunks.filter(c => hasSpanType(c, 'italic'))

      expect(boldChunks.length).toBeGreaterThan(0)
      expect(italicChunks.length).toBeGreaterThan(0)
    })

    it('should handle bold+italic combo with ***', async () => {
      parser.parseToken('This is ***bold and italic***\n')
      parser.stopParsing()

      // The chunk with "bold and italic" should have both span types
      const comboChunks = parsedChunks.filter(c =>
        hasSpanType(c, 'bold') && hasSpanType(c, 'italic')
      )
      expect(comboChunks.length).toBeGreaterThan(0)
    })

    it('should strip nested markers correctly', async () => {
      parser.parseToken('Text with **bold *and italic*** here\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      // Should not contain raw asterisks
      expect(fullText).not.toContain('**')
      expect(fullText).toContain('bold')
      expect(fullText).toContain('and italic')
    })
  })

  describe('Inline Style Names', () => {
    it('should use "code" type for inline code spans', async () => {
      parser.parseToken('Run `npm install` now\n')
      parser.stopParsing()

      const chunksWithSpans = parsedChunks.filter(c =>
        c.contained.length > 0 || c.opening.length > 0 || c.closing.length > 0
      )

      if (chunksWithSpans.length > 0) {
        // Should use 'code' span type
        const hasCodeSpan = chunksWithSpans.some(c => hasSpanType(c, 'code'))
        expect(hasCodeSpan).toBe(true)
      }
    })

    it('should detect bold style correctly', async () => {
      parser.parseToken('This is **bold** text\n')
      parser.stopParsing()

      const boldChunks = parsedChunks.filter(c => hasSpanType(c, 'bold'))
      // Should detect bold style
      expect(boldChunks.length).toBeGreaterThan(0)
    })

    it('should detect italic style correctly', async () => {
      parser.parseToken('This is *italic* text\n')
      parser.stopParsing()

      const italicChunks = parsedChunks.filter(c => hasSpanType(c, 'italic'))
      // Should detect italic style
      expect(italicChunks.length).toBeGreaterThan(0)
    })

    it('should strip asterisk markers from italic text', async () => {
      parser.parseToken('normal *italic text* normal\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      // Should contain the text without asterisk markers
      expect(fullText).toContain('italic text')
      expect(fullText).not.toContain('*italic text*')

      // Should have italic span
      const italicChunk = parsedChunks.find(c => c.text.includes('italic text'))
      expect(italicChunk).toBeDefined()
      expect(hasSpanType(italicChunk!, 'italic')).toBe(true)
    })

    it('should strip underscore markers from italic text', async () => {
      parser.parseToken('normal _underscore text_ normal\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      expect(fullText).toContain('underscore text')
      expect(fullText).not.toContain('_underscore text_')

      const italicChunk = parsedChunks.find(c => c.text.includes('underscore text'))
      expect(italicChunk).toBeDefined()
      expect(hasSpanType(italicChunk!, 'italic')).toBe(true)
    })

    it('should buffer split italic markers across chunks', async () => {
      // Simulates LLM streaming where italic markers arrive in separate chunks
      parser.parseToken('He is known for his ')
      parser.parseToken('*excep')
      parser.parseToken('tional musical abilities*')
      parser.parseToken(' and more.\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')

      // Should NOT contain asterisks in output
      expect(fullText).not.toContain('*')
      // Should contain the full italic phrase
      expect(fullText).toContain('exceptional musical abilities')

      // The italic portions should have italic span
      const italicChunks = parsedChunks.filter(c =>
        hasSpanType(c, 'italic') && c.text.trim().length > 0
      )
      expect(italicChunks.length).toBeGreaterThan(0)
    })

    it('should detect strikethrough style correctly', async () => {
      parser.parseToken('This is ~~deleted~~ text\n')
      parser.stopParsing()

      const strikethroughChunks = parsedChunks.filter(c => hasSpanType(c, 'strikethrough'))
      // Should detect strikethrough style
      expect(strikethroughChunks.length).toBeGreaterThan(0)
    })

    it('should parse inline code after stripped heading syntax', async () => {
      parser.parseToken('## Use `npm install` now\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      const codeSpan = getClosedSpans(activeChunks).find(s => s.type === 'code')

      expect(fullText).toBe('Use npm install now')
      expect(codeSpan).toBeDefined()
      expect(codeSpan?.offset).toBe('Use '.length)
      expect(codeSpan?.length).toBe('npm install'.length)
    })

    it('should parse inline code after stripped list syntax', async () => {
      parser.parseToken('- Run `npm install` now\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      const codeSpan = getClosedSpans(activeChunks).find(s => s.type === 'code')

      expect(fullText).toBe('Run npm install now\n')
      expect(codeSpan).toBeDefined()
      expect(codeSpan?.offset).toBe('Run '.length)
      expect(codeSpan?.length).toBe('npm install'.length)
    })

    it('should parse inline code after bold syntax using rendered offsets', async () => {
      parser.parseToken('Use **bold** then `code` now\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      const boldSpan = getClosedSpans(activeChunks).find(s => s.type === 'bold')
      const codeSpan = getClosedSpans(activeChunks).find(s => s.type === 'code')

      expect(fullText).toBe('Use bold then code now\n')
      expect(boldSpan?.offset).toBe('Use '.length)
      expect(boldSpan?.length).toBe('bold'.length)
      expect(codeSpan?.offset).toBe('Use bold then '.length)
      expect(codeSpan?.length).toBe('code'.length)
    })
  })

  describe('Split Inline Code', () => {
    it('should buffer split inline code delimiters across chunks', async () => {
      parser.parseToken('Run `npm')
      parser.parseToken(' install` now\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      const codeSpan = getClosedSpans(activeChunks).find(s => s.type === 'code')

      expect(fullText).toBe('Run npm install now\n')
      expect(codeSpan?.offset).toBe('Run '.length)
      expect(codeSpan?.length).toBe('npm install'.length)
    })

    it('should buffer split inline code after stripped heading syntax', async () => {
      parser.parseToken('## Run `npm')
      parser.parseToken(' install` now\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      const codeSpan = getClosedSpans(activeChunks).find(s => s.type === 'code')

      expect(fullText).toBe('Run npm install now')
      expect(codeSpan?.offset).toBe('Run '.length)
      expect(codeSpan?.length).toBe('npm install'.length)
    })

    it('should flush unmatched inline backtick content at stream end', async () => {
      parser.parseToken('Run `npm install now\n')
      parser.stopParsing()

      const fullText = parsedChunks.map(c => c.text).join('')
      expect(fullText).toBe('Run `npm install now\n')
    })
  })

  describe('Real LLM Stream Integration', () => {
    it('should parse gpt-4.5-cat-coding stream correctly', async () => {
      const examplePath = path.join(__dirname, '../demo/llm-streams-examples/gpt-4.5-cat-coding.json')

      if (!fs.existsSync(examplePath)) {
        console.warn('Example file not found, skipping test')
        return
      }

      const chunks = JSON.parse(fs.readFileSync(examplePath, 'utf-8'))

      // Process first 50 chunks to test Phase 1 fixes
      const testChunks = chunks.slice(0, 50)

      for (const chunk of testChunks) {
        parser.parseToken(chunk)
      }

      parser.stopParsing()

      // Check for correct block type naming (snake_case in new API)
      const codeBlocks = parsedChunks.filter(c => c.block.type === 'code_block')

      // Check headers don't include markers
      const headers = parsedChunks.filter(c => c.block.type === 'heading')
      const headersWithMarkers = headers.filter(c => c.text && c.text.match(/^#+\s/))
      expect(headersWithMarkers.length).toBe(0)
    })

    it('should render entire cat-coding stream without missing parts', async () => {
      const chunksPath = path.join(__dirname, '../demo/llm-streams-examples/gpt-4.5-cat-coding.json')

      if (!fs.existsSync(chunksPath)) {
        console.warn('Example file not found, skipping test')
        return
      }

      const chunks: string[] = JSON.parse(fs.readFileSync(chunksPath, 'utf-8'))

      for (const chunk of chunks) {
        parser.parseToken(chunk)
      }
      parser.stopParsing()

      // Reconstruct full text
      const fullText = parsedChunks.map(c => c.text).join('')

      // Check that key content is present
      expect(fullText).toContain('cat_breeds')
      expect(fullText).toContain('matched_breeds')
      expect(fullText).toContain('find_cat_breeds')
      expect(fullText).toContain('breed_pattern')
      expect(fullText).toContain('Regex Pattern Explained')
      expect(fullText).toContain('Challenge yourself next')

      // Ensure nothing is stuck in buffer (should have reasonable chunk count)
      expect(parsedChunks.length).toBeGreaterThan(100)
    })

    it('should detect code block when ```regex is followed by minimal content', async () => {
      // This is the exact chunking pattern from claude-3.5-long-regex.json
      const chunks = [
        "Let",
        " me create a complex",
        " regex pattern that",
        "'s approximately 200 characters long",
        ". This",
        " pattern will be quite extensive an",
        "d might be use",
        "d for various matching",
        " scenarios.\n\nHere",
        "'s the regex pattern:\n",
        "\n\n```regex\n^",  // This was the problematic chunk!
        "(?:[A-Za",
        "-z0-9",
      ]

      for (const chunk of chunks) {
        parser.parseToken(chunk)
      }
      parser.stopParsing()

      // Find code block chunks
      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')

      // Check that we DO have code block chunks
      expect(codeBlockChunks.length).toBeGreaterThan(0)

      // The triple backticks should not appear in the output
      const allText = parsedChunks.map(c => c.text).join('')
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // The ^ and regex content should be in a code_block
      const codeContent = codeBlockChunks.map(c => c.text).join('')
      expect(codeContent).toContain('^')
    })

    it('should parse claude-3.5-long-regex stream correctly', async () => {
      const jsonPath = path.join(__dirname, '../demo/llm-streams-examples/claude-3.5-long-regex.json')

      if (!fs.existsSync(jsonPath)) {
        console.warn('Example file not found, skipping test')
        return
      }

      const chunks = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

      for (const chunk of chunks) {
        parser.parseToken(chunk)
      }
      parser.stopParsing()

      const allText = parsedChunks.map(c => c.text).join('')

      // The triple backticks should not appear in the output
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // Should have code block chunks with the regex language
      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      expect(codeBlockChunks.length).toBeGreaterThan(0)

      // Check language detection
      const hasRegexLanguage = codeBlockChunks.some(c => c.block.language === 'regex')
      expect(hasRegexLanguage).toBe(true)
    })

    it('should parse claude-3.5-very-long-regex stream correctly', async () => {
      const jsonPath = path.join(__dirname, '../demo/llm-streams-examples/claude-3.5-very-long-regex.json')

      if (!fs.existsSync(jsonPath)) {
        console.warn('Example file not found, skipping test')
        return
      }

      const chunks = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

      for (const chunk of chunks) {
        parser.parseToken(chunk)
      }
      parser.stopParsing()

      const allText = parsedChunks.map(c => c.text).join('')

      // Should not contain raw triple backticks
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // Should have code block chunks
      const codeBlockChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      expect(codeBlockChunks.length).toBeGreaterThan(0)
    })
  })

  describe('Output Structure Validation', () => {
    it('should have correct output structure with new chunk API', async () => {
      parser.parseToken('## Header\n')
      parser.parseToken('Paragraph text.\n')
      parser.stopParsing()

      parsedChunks.forEach(chunk => {
        // Required fields for new Chunk type
        expect(chunk).toHaveProperty('text')
        expect(chunk).toHaveProperty('offset')
        expect(chunk).toHaveProperty('length')
        expect(chunk).toHaveProperty('block')
        expect(chunk).toHaveProperty('opening')
        expect(chunk).toHaveProperty('closing')
        expect(chunk).toHaveProperty('contained')

        // Block should have type
        expect(chunk.block).toHaveProperty('type')

        // Types should be correct
        expect(typeof chunk.text).toBe('string')
        expect(typeof chunk.offset).toBe('number')
        expect(typeof chunk.length).toBe('number')
        expect(typeof chunk.block.type).toBe('string')
        expect(Array.isArray(chunk.opening)).toBe(true)
        expect(Array.isArray(chunk.closing)).toBe(true)
        expect(Array.isArray(chunk.contained)).toBe(true)
      })
    })

    it('should have UTF-16 offsets in chunks', async () => {
      parser.parseToken('Hello ')
      parser.parseToken('world\n')
      parser.stopParsing()

      // Check that offsets are tracked
      if (parsedChunks.length > 0) {
        expect(parsedChunks[0].offset).toBeGreaterThanOrEqual(0)
        expect(parsedChunks[0].length).toBeGreaterThan(0)
      }
    })

    it('should use rendered offsets after stripping heading markers', async () => {
      parser.parseToken('## ')
      parser.parseToken('Title\n')
      parser.parseToken('Next\n')
      parser.stopParsing()

      const rendered = parsedChunks.map(c => c.text).join('')
      expect(rendered).toBe('TitleNext\n')

      const title = parsedChunks.find(c => c.text.includes('Title'))
      const next = parsedChunks.find(c => c.text.includes('Next'))
      expect(title?.offset).toBe(0)
      expect(title?.length).toBe('Title'.length)
      expect(next?.offset).toBe('Title'.length)
    })

    it('should use rendered offsets and lengths for inline spans', async () => {
      parser.parseToken('Hello **world**\n')
      parser.stopParsing()

      const rendered = parsedChunks.map(c => c.text).join('')
      expect(rendered).toBe('Hello world\n')

      const boldSpan = parsedChunks.flatMap(c => c.contained).find(s => s.type === 'bold')
      expect(boldSpan).toBeDefined()
      expect(boldSpan?.offset).toBe('Hello '.length)
      expect(boldSpan?.length).toBe('world'.length)
    })

    it('should use rendered offsets after stripping code fences', async () => {
      parser.parseToken('```js\n')
      parser.parseToken('code\n')
      parser.parseToken('```\n')
      parser.parseToken('After\n')
      parser.stopParsing()

      const rendered = parsedChunks.map(c => c.text).join('')
      expect(rendered).toBe('code\nAfter\n')

      const code = parsedChunks.find(c => c.block.type === 'code_block' && c.text.includes('code'))
      const after = parsedChunks.find(c => c.text.includes('After'))
      expect(code?.offset).toBe(0)
      expect(after?.offset).toBe('code\n'.length)
    })
  })
  describe('Table Inline Code', () => {
    it('should strip backticks from inline code inside tables', async () => {
      parser.parseToken('| Col | `code` |\n')
      parser.stopParsing()

      const cellChunks = parsedChunks.filter(c => c.text.trim() === 'code')
      const rawChunks = parsedChunks.filter(c => c.text === '`code`')

      // Should have stripped backticks
      expect(rawChunks.length).toBe(0)
      expect(cellChunks.length).toBeGreaterThan(0)
      expect(hasSpanType(cellChunks[0], 'code')).toBe(true)
    })

    it('should detect table block types for complete tables', async () => {
      parser.parseToken('| A | B |\n')
      parser.parseToken('|---|---|\n')
      parser.parseToken('| 1 | 2 |\n')
      parser.stopParsing()

      // Should have table-related chunks
      const tableChunks = parsedChunks.filter(c =>
        c.block.type === 'table' || c.block.type === 'table_row' || c.block.type === 'table_cell'
      )

      expect(tableChunks.length).toBeGreaterThan(0)
    })

    it('should suppress pipe delimiters from output', async () => {
      parser.parseToken('| A | B |\n')
      parser.parseToken('|---|---|\n')
      parser.parseToken('| 1 | 2 |\n')
      parser.stopParsing()

      // Should NOT have any chunks that are just '|' or '| '
      const pipeChunks = parsedChunks.filter(c => /^\|[\s]*$/.test(c.text))

      expect(pipeChunks.length).toBe(0)
    })

    it('should suppress delimiter row content', async () => {
      parser.parseToken('| A |\n')
      parser.parseToken('|---|\n')
      parser.parseToken('| B |\n')
      parser.stopParsing()

      // Should NOT have any chunks containing '---'
      const delimiterChunks = parsedChunks.filter(c => c.text.includes('---'))

      expect(delimiterChunks.length).toBe(0)
    })

    it('should handle inline code in full table structure', async () => {
      parser.parseToken('| Header |\n')
      parser.parseToken('|--------|\n')
      parser.parseToken('| `code` |\n')
      parser.stopParsing()

      // Should have code chunk with proper span
      const codeChunks = parsedChunks.filter(c => hasSpanType(c, 'code'))

      expect(codeChunks.length).toBeGreaterThan(0)
      // Code should be stripped of backticks
      const hasStrippedCode = codeChunks.some(c => c.text.trim() === 'code')
      expect(hasStrippedCode).toBe(true)
    })
  })

  describe('Error Recovery', () => {
    it('should not emit backtrackOffset for clean streaming', async () => {
      parser.parseToken('Hello ')
      parser.parseToken('world\n')
      parser.stopParsing()

      // No chunks should have backtrackOffset set
      const backtrackChunks = parsedChunks.filter(c => c.backtrackOffset !== undefined)
      expect(backtrackChunks.length).toBe(0)
    })

    it('should emit backtrackOffset when table header is reclassified', async () => {
      // When '| Col A | Col B |' arrives alone, tree-sitter parses it as paragraph.
      // When '| --- | --- |' arrives next, tree-sitter reclassifies the first line
      // as pipe_table_header — a genuine block-level structural change.
      const tableId = 'test-table-backtrack'
      const tableParser = await MarkdownStreamParser.getInstance(tableId)
      const tableChunks: Chunk[] = []

      tableParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING' && chunk.chunk) {
          tableChunks.push(chunk.chunk)
        }
      })

      tableParser.startParsing()
      tableParser.parseToken('| Col A | Col B |\n')
      tableParser.parseToken('| --- | --- |\n')
      tableParser.parseToken('| cell1 | cell2 |\n')
      tableParser.stopParsing()

      const backtrackChunks = tableChunks.filter(c => c.backtrackOffset !== undefined)
      expect(backtrackChunks.length).toBeGreaterThan(0)

      const firstBacktrack = backtrackChunks[0]
      expect(firstBacktrack.backtrackOffset).toBeDefined()
      expect(typeof firstBacktrack.backtrackOffset).toBe('number')
      expect(firstBacktrack.backtrackOffset!).toBeGreaterThanOrEqual(0)

      MarkdownStreamParser.removeInstance(tableId)
    })

    it('should re-emit corrected segments from backtrack point', async () => {
      const tableId = 'test-table-reemit'
      const tableParser = await MarkdownStreamParser.getInstance(tableId)
      const tableChunks: Chunk[] = []

      tableParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING' && chunk.chunk) {
          tableChunks.push(chunk.chunk)
        }
      })

      tableParser.startParsing()
      tableParser.parseToken('| Name | Age |\n')
      tableParser.parseToken('| --- | --- |\n')
      tableParser.parseToken('| Alice | 30 |\n')
      tableParser.stopParsing()

      // After backtracking, re-generated chunks should be emitted
      const backtrackChunks = tableChunks.filter(c => c.backtrackOffset !== undefined)
      expect(backtrackChunks.length).toBeGreaterThan(0)

      // Reconstruct text using only the LATEST chunks (simulating a consumer
      // that discards old content when backtrackOffset is seen)
      let activeChunks = [...tableChunks]
      for (const btChunk of backtrackChunks) {
        const btOffset = btChunk.backtrackOffset!
        const btIdx = activeChunks.indexOf(btChunk)
        // Discard everything from btOffset onwards, keep only chunks before
        activeChunks = [
          ...activeChunks.filter((c, idx) => idx < btIdx && c.offset + c.length <= btOffset),
          ...activeChunks.slice(btIdx)
        ]
      }

      const fullText = activeChunks.map(c => c.text).join('')
      expect(fullText).toContain('Name')
      expect(fullText).toContain('Age')
      expect(fullText).toContain('Alice')

      MarkdownStreamParser.removeInstance(tableId)
    })

    it('should respect windowSize configuration', async () => {
      const windowInstanceId = 'test-window-size'
      const windowParser = await MarkdownStreamParser.getInstance(windowInstanceId, {
        windowSize: 500,
      })

      const windowChunks: Chunk[] = []
      windowParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING' && chunk.chunk) {
          windowChunks.push(chunk.chunk)
        }
      })

      windowParser.startParsing()
      // Table reclassification triggers backtracking
      windowParser.parseToken('| Header1 | Header2 |\n')
      windowParser.parseToken('| --- | --- |\n')
      windowParser.stopParsing()

      const backtrackChunks = windowChunks.filter(c => c.backtrackOffset !== undefined)
      if (backtrackChunks.length > 0) {
        // Find the furthest emit point before the backtrack chunk
        const btChunk = backtrackChunks[0]
        const btIdx = windowChunks.indexOf(btChunk)
        const priorChunks = windowChunks.slice(0, btIdx).filter(c => c.backtrackOffset === undefined)

        if (priorChunks.length > 0) {
          const lastEmitted = Math.max(...priorChunks.map(c => c.offset + c.length))
          const distance = lastEmitted - btChunk.backtrackOffset!
          // The backtrack distance should not exceed windowSize
          expect(distance).toBeLessThanOrEqual(500)
        }

        expect(btChunk.recovery).toBeUndefined()
      }

      MarkdownStreamParser.removeInstance(windowInstanceId)
    })

    it('should report recovery metadata when required correction exceeds windowSize', async () => {
      const windowInstanceId = 'test-window-size-overflow'
      const windowParser = await MarkdownStreamParser.getInstance(windowInstanceId, {
        windowSize: 256,
      })

      const windowChunks: Chunk[] = []
      windowParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING' && chunk.chunk) {
          windowChunks.push(chunk.chunk)
        }
      })

      windowParser.startParsing()

      const columnCount = 40
      const headerCells = Array.from({ length: columnCount }, (_, i) => `column${i}`).join(' | ')
      const delimiterCells = Array.from({ length: columnCount }, () => '---').join(' | ')
      windowParser.parseToken(`| ${headerCells} |\n`)
      windowParser.parseToken(`| ${delimiterCells} |\n`)
      windowParser.stopParsing()

      const overflowChunk = windowChunks.find(c => c.recovery?.type === 'window_overflow')
      expect(overflowChunk).toBeDefined()
      expect(overflowChunk?.backtrackOffset).toBeDefined()

      const overflowIdx = windowChunks.indexOf(overflowChunk!)
      const priorChunks = windowChunks.slice(0, overflowIdx).filter(c => c.backtrackOffset === undefined)
      expect(priorChunks.length).toBeGreaterThan(0)

      const lastEmitted = Math.max(...priorChunks.map(c => c.offset + c.length))
      expect(overflowChunk!.backtrackOffset!).toBeGreaterThanOrEqual(lastEmitted - 256)
      expect(overflowChunk!.recovery).toMatchObject({
        type: 'window_overflow',
        windowSize: 256,
        appliedBacktrackOffset: overflowChunk!.backtrackOffset,
      })
      expect(overflowChunk!.recovery!.fullBacktrackOffset).toBeLessThan(overflowChunk!.recovery!.appliedBacktrackOffset)

      MarkdownStreamParser.removeInstance(windowInstanceId)
    })

    it('should reject invalid windowSize configuration', async () => {
      await expect(MarkdownStreamParser.getInstance('test-window-size-negative', {
        windowSize: -1,
      })).rejects.toThrow(RangeError)

      await expect(MarkdownStreamParser.getInstance('test-window-size-nan', {
        windowSize: NaN,
      })).rejects.toThrow(RangeError)

      await expect(MarkdownStreamParser.getInstance('test-window-size-infinity', {
        windowSize: Infinity,
      })).rejects.toThrow(RangeError)

      expect(() => parser.setConfig({ windowSize: -1 })).toThrow(RangeError)
      expect(() => parser.setConfig({ windowSize: NaN })).toThrow(RangeError)
      expect(() => parser.setConfig({ windowSize: Infinity })).toThrow(RangeError)
    })

    it('should backtrack using rendered offsets after preceding markdown syntax', async () => {
      const recoveryId = 'test-rendered-backtrack-offset'
      const recoveryParser = await MarkdownStreamParser.getInstance(recoveryId)
      const recoveryChunks: Chunk[] = []

      recoveryParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          recoveryChunks.push(chunk.chunk)
        }
      })

      recoveryParser.startParsing()
      recoveryParser.parseToken('## ')
      recoveryParser.parseToken('Before\n\n')
      recoveryParser.parseToken('| Name | Age |\n')
      recoveryParser.parseToken('| --- | --- |\n')
      recoveryParser.parseToken('| Alice | 30 |\n')
      recoveryParser.stopParsing()

      const backtrack = recoveryChunks.find(c => c.backtrackOffset !== undefined)
      expect(backtrack).toBeDefined()
      expect(backtrack?.backtrackOffset).toBe('Before'.length)

      const activeChunks = applyBacktracks(recoveryChunks)
      const fullText = activeChunks.map(c => c.text).join('')
      expect(fullText).toContain('Before')
      expect(fullText).toContain('Name')
      expect(fullText).toContain('Age')
      expect(fullText).toContain('Alice')

      MarkdownStreamParser.removeInstance(recoveryId)
    })

    it('should keep raw source originals while recovery offsets stay rendered', async () => {
      const rawId = 'test-recovery-raw-original'
      const rawParser = await MarkdownStreamParser.getInstance(rawId, {
        includeRawStreamedToken: true,
      })
      const rawChunks: Chunk[] = []

      rawParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          rawChunks.push(chunk.chunk)
        }
      })

      rawParser.startParsing()
      rawParser.parseToken('Intro\n\n')
      rawParser.parseToken('| Name | Age |\n')
      rawParser.parseToken('| --- | --- |\n')
      rawParser.stopParsing()

      const backtrack = rawChunks.find(c => c.backtrackOffset !== undefined)
      expect(backtrack).toBeDefined()
      expect(backtrack?.backtrackOffset).toBe('Intro\n\n'.length)
      expect(rawChunks.some(c => c.original?.includes('Name'))).toBe(true)

      MarkdownStreamParser.removeInstance(rawId)
    })

    it('should recover from the errored subtree instead of replaying the full document', async () => {
      const recoveryId = 'test-error-offset-subtree'
      const recoveryParser = await MarkdownStreamParser.getInstance(recoveryId)
      const recoveryChunks: Chunk[] = []

      recoveryParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          recoveryChunks.push(chunk.chunk)
        }
      })

      recoveryParser.startParsing()
      processRawAndCollect(recoveryParser, 'Intro text\n\n', recoveryChunks)
      processRawAndCollect(recoveryParser, '# [', recoveryChunks)
      processRawAndCollect(recoveryParser, ']', recoveryChunks)
      recoveryParser.stopParsing()

      const backtrack = recoveryChunks.find(c => c.backtrackOffset !== undefined)
      expect(backtrack).toBeDefined()
      expect(backtrack!.backtrackOffset).toBeGreaterThan(0)
      expect(backtrack!.backtrackOffset).toBeLessThanOrEqual('Intro text\n\n'.length)

      MarkdownStreamParser.removeInstance(recoveryId)
    })

    it('should emit deletion-only recovery chunks when replay produces no replacement segments', async () => {
      const recoveryId = 'test-deletion-only-recovery'
      const recoveryParser = await MarkdownStreamParser.getInstance(recoveryId)
      const recoveryChunks: Chunk[] = []

      recoveryParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          recoveryChunks.push(chunk.chunk)
        }
      })

      recoveryParser.startParsing()
      processRawAndCollect(recoveryParser, 'Intro\n\n', recoveryChunks)
      processRawAndCollect(recoveryParser, '# [foo', recoveryChunks)
      processRawAndCollect(recoveryParser, ']', recoveryChunks)
      recoveryParser.stopParsing()

      const deletion = recoveryChunks.find(c =>
        c.backtrackOffset !== undefined &&
        c.text === '' &&
        c.length === 0
      )

      expect(deletion).toBeDefined()
      expect(deletion!.backtrackOffset).toBe('Intro\n\n'.length)

      MarkdownStreamParser.removeInstance(recoveryId)
    })

    it('should preserve older checkpoints across successive recoveries', async () => {
      const recoveryId = 'test-successive-recovery-checkpoints'
      const recoveryParser = await MarkdownStreamParser.getInstance(recoveryId)
      const recoveryChunks: Chunk[] = []

      recoveryParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          recoveryChunks.push(chunk.chunk)
        }
      })

      recoveryParser.startParsing()
      recoveryParser.parseToken('Intro\n\n')
      recoveryParser.parseToken('| Name | Age |\n')
      recoveryParser.parseToken('| --- | --- |\n')
      recoveryParser.parseToken('\n# ')
      recoveryParser.parseToken('[')
      recoveryParser.parseToken('heading](https://example.com)\n')
      recoveryParser.stopParsing()

      const backtracks = recoveryChunks.filter(c => c.backtrackOffset !== undefined)
      expect(backtracks.length).toBeGreaterThanOrEqual(2)
      expect(backtracks[1].backtrackOffset).toBeGreaterThan(0)

      MarkdownStreamParser.removeInstance(recoveryId)
    })
  })

  describe('Code Fence Recovery', () => {
    it('should strip split code fences and emit code block content', async () => {
      parser.parseToken('Text before\n')
      parser.parseToken('```js\n')
      parser.parseToken('const x = 1\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const allText = parsedChunks.map(c => c.text).join('')
      const codeChunks = parsedChunks.filter(c => c.block.type === 'code_block')

      expect(allText).toContain('Text before')
      expect(allText).toContain('const x = 1')
      expect(allText).not.toContain('```')
      expect(codeChunks.map(c => c.text).join('')).toContain('const x = 1')
      expect(codeChunks.some(c => c.block.language === 'js')).toBe(true)
    })

    it('should recover when an emitted paragraph is reclassified as a code fence', async () => {
      const codeFenceId = 'test-code-fence-reclassification'
      const codeFenceParser = await MarkdownStreamParser.getInstance(codeFenceId)
      const codeFenceChunks: Chunk[] = []

      codeFenceParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          codeFenceChunks.push(chunk.chunk)
        }
      })

      codeFenceParser.startParsing()
      codeFenceParser.parseToken('Text before\n\n')
      codeFenceParser.parseToken('```')
      codeFenceParser.parseToken('js\n')
      codeFenceParser.parseToken('const x = 1\n')
      codeFenceParser.stopParsing()

      const activeChunks = applyBacktracks(codeFenceChunks)
      const allText = activeChunks.map(c => c.text).join('')
      const codeChunks = activeChunks.filter(c => c.block.type === 'code_block')

      expect(allText).toContain('Text before')
      expect(allText).toContain('const x = 1')
      expect(allText).not.toContain('```')
      expect(allText).not.toContain('js\nconst x')
      expect(codeChunks.map(c => c.text).join('')).toContain('const x = 1')
      expect(codeChunks.some(c => c.block.language === 'js')).toBe(true)

      MarkdownStreamParser.removeInstance(codeFenceId)
    })

    it('should emit unclosed fence content as code at stream end', async () => {
      parser.parseToken('```python\n')
      parser.parseToken('print("hi")\n')
      parser.stopParsing()

      const allText = parsedChunks.map(c => c.text).join('')
      const codeChunks = parsedChunks.filter(c => c.block.type === 'code_block')

      expect(allText).toBe('print("hi")\n')
      expect(allText).not.toContain('```')
      expect(codeChunks.map(c => c.text).join('')).toBe('print("hi")\n')
      expect(codeChunks.some(c => c.block.language === 'python')).toBe(true)
    })

    it('should use rendered offsets for code fences after stripped markdown syntax', async () => {
      parser.parseToken('## ')
      parser.parseToken('Heading\n\n')
      parser.parseToken('```ts\n')
      parser.parseToken('let a = 1\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const heading = parsedChunks.find(c => c.block.type === 'heading')
      const codeChunks = parsedChunks.filter(c => c.block.type === 'code_block')
      const firstCode = codeChunks[0]
      const backtrack = parsedChunks.find(c => c.backtrackOffset !== undefined)

      expect(heading?.text).toBe('Heading')
      expect(codeChunks.map(c => c.text).join('')).toBe('let a = 1\n')
      expect(firstCode?.offset).toBe('Heading'.length)
      if (backtrack) {
        expect(backtrack.backtrackOffset).toBeGreaterThanOrEqual(0)
        expect(backtrack.backtrackOffset).toBeLessThanOrEqual('Heading'.length)
      }
    })

    it('should strip an opening fence split across chunks', async () => {
      parser.parseToken('``')
      parser.parseToken('`js\n')
      parser.parseToken('const x = 1\n')
      parser.stopParsing()

      const activeChunks = applyBacktracks(parsedChunks)
      const allText = activeChunks.map(c => c.text).join('')
      const codeChunks = activeChunks.filter(c => c.block.type === 'code_block')

      expect(allText).toBe('const x = 1\n')
      expect(codeChunks.map(c => c.text).join('')).toBe('const x = 1\n')
      expect(codeChunks.some(c => c.block.language === 'js')).toBe(true)
    })

    it('should keep rendered offsets when a fence follows stripped formatting', async () => {
      const codeFenceId = 'test-code-fence-rendered-reclassification'
      const codeFenceParser = await MarkdownStreamParser.getInstance(codeFenceId)
      const codeFenceChunks: Chunk[] = []

      codeFenceParser.subscribeToTokenParse((chunk) => {
        if (chunk.status === 'STREAMING') {
          codeFenceChunks.push(chunk.chunk)
        }
      })

      codeFenceParser.startParsing()
      codeFenceParser.parseToken('- Before\n\n')
      codeFenceParser.parseToken('```')
      codeFenceParser.parseToken('js\n')
      codeFenceParser.parseToken('const x = 1\n')
      codeFenceParser.stopParsing()

      const backtrack = codeFenceChunks.find(c => c.backtrackOffset !== undefined)
      const activeChunks = applyBacktracks(codeFenceChunks)
      const allText = activeChunks.map(c => c.text).join('')

      expect(allText).toContain('Before')
      expect(allText).toContain('const x = 1')
      expect(allText).not.toContain('```')
      if (backtrack) {
        expect(backtrack.backtrackOffset).toBe('Before'.length)
      }

      MarkdownStreamParser.removeInstance(codeFenceId)
    })
  })
})
