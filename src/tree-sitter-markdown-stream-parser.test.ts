import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MarkdownStreamParser } from './tree-sitter-markdown-stream-parser'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

describe('Tree-Sitter MarkdownStreamParser - Phase 1: Quick Wins', () => {
  let parser: MarkdownStreamParser
  let parsedSegments: any[] = []
  const instanceId = 'test-tree-sitter'

  // Set up path for WASM files
  const wasmDir = path.join(__dirname, '../demo/svelte-demo/static')

  beforeEach(async () => {
    parsedSegments = []

    // Configure WASM path for testing - this will also help locateFile find tree-sitter.wasm
    MarkdownStreamParser.configureWasmPath(path.join(wasmDir, 'tree-sitter-markdown.wasm'))

    parser = await MarkdownStreamParser.getInstance(instanceId)

    parser.subscribeToTokenParse((chunk) => {
      if (chunk.status === 'STREAMING' && chunk.segment) {
        parsedSegments.push(chunk.segment)
      }
    })

    parser.startParsing()
  })

  afterEach(() => {
    parser.stopParsing()
    MarkdownStreamParser.removeInstance(instanceId)
  })

  describe('Basic Block Types', () => {
    it('should use camelCase for block type names', async () => {
      parser.parseToken('```javascript\n')
      parser.parseToken('code\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockSegments = parsedSegments.filter(s => s.type.includes('code') || s.type.includes('Code'))
      expect(codeBlockSegments.length).toBeGreaterThan(0)

      // Should be 'codeBlock' not 'code_block'
      const hasCorrectNaming = codeBlockSegments.some(s => s.type === 'codeBlock')
      expect(hasCorrectNaming).toBe(true)
    })

    it('should extract language from code blocks', async () => {
      parser.parseToken('```javascript\n')
      parser.parseToken('const x = 1;\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockSegments = parsedSegments.filter(s => s.type === 'codeBlock')
      expect(codeBlockSegments.length).toBeGreaterThan(0)

      // Should have language field
      const hasLanguage = codeBlockSegments.some(s => s.language === 'javascript')
      expect(hasLanguage).toBe(true)
    })

    it('should handle code blocks without language', async () => {
      parser.parseToken('```\n')
      parser.parseToken('code\n')
      parser.parseToken('```\n')
      parser.stopParsing()

      const codeBlockSegments = parsedSegments.filter(s => s.type === 'codeBlock')
      expect(codeBlockSegments.length).toBeGreaterThan(0)

      // Language should be empty string or undefined
      const firstCodeBlock = codeBlockSegments[0]
      expect(firstCodeBlock.language === '' || firstCodeBlock.language === undefined).toBe(true)
    })
  })

  describe('Header Processing', () => {
    it('should strip header markers from content', async () => {
      parser.parseToken('## ')
      parser.parseToken('Header Text\n')
      parser.stopParsing()

      const headerSegments = parsedSegments.filter(s => s.type === 'header')
      expect(headerSegments.length).toBeGreaterThan(0)

      // Content should NOT include ##
      const headerContent = headerSegments.map(s => s.segment).join('')
      expect(headerContent).not.toContain('##')
      expect(headerContent.trim()).toBe('Header Text')
    })

    it('should detect all 6 header levels correctly', async () => {
      const levels = [1, 2, 3, 4, 5, 6]

      for (const level of levels) {
        parsedSegments = []
        parser = await MarkdownStreamParser.getInstance(`test-${level}`)
        parser.subscribeToTokenParse((chunk) => {
          if (chunk.status === 'STREAMING' && chunk.segment) {
            parsedSegments.push(chunk.segment)
          }
        })
        parser.startParsing()

        const markers = '#'.repeat(level)
        parser.parseToken(`${markers} `)
        parser.parseToken(`Level ${level}\n`)
        parser.stopParsing()

        const headerSegments = parsedSegments.filter(s => s.type === 'header')
        expect(headerSegments.length).toBeGreaterThan(0)
        expect(headerSegments[0].level).toBe(level)

        MarkdownStreamParser.removeInstance(`test-${level}`)
      }
    })

    it('should handle multiple headers in sequence', async () => {
      parser.parseToken('# First\n')
      parser.parseToken('## Second\n')
      parser.parseToken('### Third\n')
      parser.stopParsing()

      const headerSegments = parsedSegments.filter(s => s.type === 'header')
      expect(headerSegments.length).toBeGreaterThan(0)

      // Check that content doesn't include markers
      headerSegments.forEach(seg => {
        expect(seg.segment).not.toMatch(/^#+\s/)
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

      const blockquoteSegments = parsedSegments.filter(s => s.type === 'blockquote')
      expect(blockquoteSegments.length).toBeGreaterThan(0)
    })

    it.skip('should strip blockquote marker from content', async () => {
      parser.parseToken('> Quoted text\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')
      // Should not contain the > marker
      expect(fullText).not.toMatch(/^>/)
      expect(fullText).toContain('Quoted text')
    })

    it.skip('should handle multiline blockquotes', async () => {
      parser.parseToken('> Line one\n')
      parser.parseToken('> Line two\n')
      parser.stopParsing()

      const blockquoteSegments = parsedSegments.filter(s => s.type === 'blockquote')
      expect(blockquoteSegments.length).toBeGreaterThan(0)

      const fullText = blockquoteSegments.map(s => s.segment).join('')
      expect(fullText).toContain('Line one')
      expect(fullText).toContain('Line two')
    })

    it.skip('should handle nested blockquotes', async () => {
      parser.parseToken('> Outer quote\n')
      parser.parseToken('>> Nested quote\n')
      parser.stopParsing()

      const blockquoteSegments = parsedSegments.filter(s => s.type === 'blockquote')
      expect(blockquoteSegments.length).toBeGreaterThan(0)
    })
  })

  describe('List Items', () => {
    it('should detect unordered list items', async () => {
      parser.parseToken('- First item\n')
      parser.parseToken('- Second item\n')
      parser.stopParsing()

      const listSegments = parsedSegments.filter(s => s.type === 'list_item')
      expect(listSegments.length).toBeGreaterThan(0)
    })

    it('should strip list markers from content', async () => {
      parser.parseToken('- List content\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')
      // Should not contain the - marker at start
      expect(fullText).not.toMatch(/^-\s/)
      expect(fullText).toContain('List content')
    })

    it('should detect ordered list items', async () => {
      parser.parseToken('1. First\n')
      parser.parseToken('2. Second\n')
      parser.stopParsing()

      const listSegments = parsedSegments.filter(s => s.type === 'list_item')
      expect(listSegments.length).toBeGreaterThan(0)
    })

    it('should handle nested list items', async () => {
      parser.parseToken('- Parent\n')
      parser.parseToken('  - Child\n')
      parser.stopParsing()

      const listSegments = parsedSegments.filter(s => s.type === 'list_item')
      expect(listSegments.length).toBeGreaterThan(0)
    })

    it('should handle asterisk list markers', async () => {
      parser.parseToken('* Item one\n')
      parser.parseToken('* Item two\n')
      parser.stopParsing()

      const listSegments = parsedSegments.filter(s => s.type === 'list_item')
      expect(listSegments.length).toBeGreaterThan(0)
    })
  })

  describe('Nested Inline Styles', () => {
    it('should detect bold inside italic', async () => {
      parser.parseToken('This is *italic with **bold** inside*\n')
      parser.stopParsing()

      const boldSegments = parsedSegments.filter(s => s.styles && s.styles.includes('bold'))
      const italicSegments = parsedSegments.filter(s => s.styles && s.styles.includes('italic'))

      expect(italicSegments.length).toBeGreaterThan(0)
      expect(boldSegments.length).toBeGreaterThan(0)
    })

    it('should detect italic inside bold', async () => {
      parser.parseToken('This is **bold with *italic* inside**\n')
      parser.stopParsing()

      const boldSegments = parsedSegments.filter(s => s.styles && s.styles.includes('bold'))
      const italicSegments = parsedSegments.filter(s => s.styles && s.styles.includes('italic'))

      expect(boldSegments.length).toBeGreaterThan(0)
      expect(italicSegments.length).toBeGreaterThan(0)
    })

    it('should handle bold+italic combo with ***', async () => {
      parser.parseToken('This is ***bold and italic***\n')
      parser.stopParsing()

      // The segment with "bold and italic" should have both styles
      const comboSegments = parsedSegments.filter(s =>
        s.styles && s.styles.includes('bold') && s.styles.includes('italic')
      )
      expect(comboSegments.length).toBeGreaterThan(0)
    })

    it('should strip nested markers correctly', async () => {
      parser.parseToken('Text with **bold *and italic*** here\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')
      // Should not contain raw asterisks
      expect(fullText).not.toContain('**')
      expect(fullText).toContain('bold')
      expect(fullText).toContain('and italic')
    })
  })

  describe('Inline Style Names', () => {
    it('should use "code" not "inline_code" for inline code', async () => {
      parser.parseToken('Run `npm install` now\n')
      parser.stopParsing()

      const styledSegments = parsedSegments.filter(s => s.styles && s.styles.length > 0)

      if (styledSegments.length > 0) {
        // Should use 'code' not 'inline_code'
        const hasCorrectStyleName = styledSegments.some(s => s.styles.includes('code'))
        const hasWrongStyleName = styledSegments.some(s => s.styles.includes('inline_code'))

        expect(hasCorrectStyleName).toBe(true)
        expect(hasWrongStyleName).toBe(false)
      }
    })

    it('should detect bold style correctly', async () => {
      parser.parseToken('This is **bold** text\n')
      parser.stopParsing()

      const styledSegments = parsedSegments.filter(s => s.styles && s.styles.includes('bold'))
      // Should detect bold style
      expect(styledSegments.length).toBeGreaterThan(0)
    })

    it('should detect italic style correctly', async () => {
      parser.parseToken('This is *italic* text\n')
      parser.stopParsing()

      const styledSegments = parsedSegments.filter(s => s.styles && s.styles.includes('italic'))
      // Should detect italic style
      expect(styledSegments.length).toBeGreaterThan(0)
    })

    it('should strip asterisk markers from italic text', async () => {
      parser.parseToken('normal *italic text* normal\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')
      // Should contain the text without asterisk markers
      expect(fullText).toContain('italic text')
      expect(fullText).not.toContain('*italic text*')

      // Should have italic style applied
      const italicSegment = parsedSegments.find(s => s.segment.includes('italic text'))
      expect(italicSegment).toBeDefined()
      expect(italicSegment.styles).toContain('italic')
    })

    it('should strip underscore markers from italic text', async () => {
      parser.parseToken('normal _underscore text_ normal\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')
      expect(fullText).toContain('underscore text')
      expect(fullText).not.toContain('_underscore text_')

      const italicSegment = parsedSegments.find(s => s.segment.includes('underscore text'))
      expect(italicSegment).toBeDefined()
      expect(italicSegment.styles).toContain('italic')
    })

    it('should buffer split italic markers across chunks', async () => {
      // Simulates LLM streaming where italic markers arrive in separate chunks
      parser.parseToken('He is known for his ')
      parser.parseToken('*excep')
      parser.parseToken('tional musical abilities*')
      parser.parseToken(' and more.\n')
      parser.stopParsing()

      const fullText = parsedSegments.map(s => s.segment).join('')

      // Should NOT contain asterisks in output
      expect(fullText).not.toContain('*')
      // Should contain the full italic phrase
      expect(fullText).toContain('exceptional musical abilities')

      // The italic portions should have italic style
      const italicSegments = parsedSegments.filter(s =>
        s.styles && s.styles.includes('italic') && s.segment.trim().length > 0
      )
      expect(italicSegments.length).toBeGreaterThan(0)
    })

    it('should detect strikethrough style correctly', async () => {
      parser.parseToken('This is ~~deleted~~ text\n')
      parser.stopParsing()

      const styledSegments = parsedSegments.filter(s => s.styles && s.styles.includes('strikethrough'))
      // Should detect strikethrough style
      expect(styledSegments.length).toBeGreaterThan(0)
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

      // Check for correct block type naming (camelCase)
      const codeBlocks = parsedSegments.filter(s => s.type === 'codeBlock')
      const wrongCodeBlocks = parsedSegments.filter(s => s.type === 'code_block')
      expect(wrongCodeBlocks.length).toBe(0)

      // Check for correct style names
      const wrongStyleSegments = parsedSegments.filter(s =>
        s.styles && s.styles.includes('inline_code')
      )
      expect(wrongStyleSegments.length).toBe(0)

      // Check headers don't include markers
      const headers = parsedSegments.filter(s => s.type === 'header')
      const headersWithMarkers = headers.filter(s => s.segment && s.segment.match(/^#+\s/))
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
      const fullText = parsedSegments.map(s => s.segment).join('')

      // Check that key content is present
      expect(fullText).toContain('cat_breeds')
      expect(fullText).toContain('matched_breeds')
      expect(fullText).toContain('find_cat_breeds')
      expect(fullText).toContain('breed_pattern')
      expect(fullText).toContain('Regex Pattern Explained')
      expect(fullText).toContain('Challenge yourself next')

      // Ensure nothing is stuck in buffer (should have reasonable segment count)
      expect(parsedSegments.length).toBeGreaterThan(100)
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

      // Find code block segments
      const codeBlockSegments = parsedSegments.filter(s => s.type === 'codeBlock')

      // Check that we DO have code block segments
      expect(codeBlockSegments.length).toBeGreaterThan(0)

      // The triple backticks should not appear in the output
      const allText = parsedSegments.map(s => s.segment).join('')
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // The ^ and regex content should be in a codeBlock
      const codeContent = codeBlockSegments.map(s => s.segment).join('')
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

      const allText = parsedSegments.map(s => s.segment).join('')

      // The triple backticks should not appear in the output
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // Should have code block segments with the regex language
      const codeBlockSegments = parsedSegments.filter(s => s.type === 'codeBlock')
      expect(codeBlockSegments.length).toBeGreaterThan(0)

      // Check language detection
      const hasRegexLanguage = codeBlockSegments.some(s => s.language === 'regex')
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

      const allText = parsedSegments.map(s => s.segment).join('')

      // Should not contain raw triple backticks
      expect(allText).not.toContain('```regex')
      expect(allText).not.toContain('```')

      // Should have code block segments
      const codeBlockSegments = parsedSegments.filter(s => s.type === 'codeBlock')
      expect(codeBlockSegments.length).toBeGreaterThan(0)
    })
  })

  describe('Output Structure Validation', () => {
    it('should have correct output structure matching state machine', async () => {
      parser.parseToken('## Header\n')
      parser.parseToken('Paragraph text.\n')
      parser.stopParsing()

      parsedSegments.forEach(segment => {
        // Required fields
        expect(segment).toHaveProperty('segment')
        expect(segment).toHaveProperty('type')
        expect(segment).toHaveProperty('styles')
        expect(segment).toHaveProperty('isBlockDefining')
        expect(segment).toHaveProperty('isProcessingNewLine')

        // Types should be correct
        expect(typeof segment.segment).toBe('string')
        expect(typeof segment.type).toBe('string')
        expect(Array.isArray(segment.styles)).toBe(true)
        expect(typeof segment.isBlockDefining).toBe('boolean')
        expect(typeof segment.isProcessingNewLine).toBe('boolean')
      })
    })

    it('should set isProcessingNewLine correctly', async () => {
      parser.parseToken('Text without newline ')
      parser.parseToken('and more\n')
      parser.stopParsing()

      const withNewline = parsedSegments.filter(s => s.segment.includes('\n'))
      const withoutNewline = parsedSegments.filter(s => !s.segment.includes('\n'))

      withNewline.forEach(s => {
        expect(s.isProcessingNewLine).toBe(true)
      })
    })
  })
  describe('Table Inline Code', () => {
    it('should strip backticks from inline code inside tables', async () => {
      parser.parseToken('| Col | `code` |\n')
      parser.stopParsing()

      const cellSegments = parsedSegments.filter(s => s.segment.trim() === 'code')
      const rawSegments = parsedSegments.filter(s => s.segment === '`code`')

      // Should have stripped backticks


      expect(rawSegments.length).toBe(0)
      expect(cellSegments.length).toBeGreaterThan(0)
      expect(cellSegments[0].styles).toContain('code')
    })

    it('should detect table block types for complete tables', async () => {
      parser.parseToken('| A | B |\n')
      parser.parseToken('|---|---|\n')
      parser.parseToken('| 1 | 2 |\n')
      parser.stopParsing()

      // Should have table-related segments
      const tableSegments = parsedSegments.filter(s =>
        s.type === 'table_header_cell' || s.type === 'table_cell' || s.type === 'table'
      )


      expect(tableSegments.length).toBeGreaterThan(0)
    })

    it('should suppress pipe delimiters from output', async () => {
      parser.parseToken('| A | B |\n')
      parser.parseToken('|---|---|\n')
      parser.parseToken('| 1 | 2 |\n')
      parser.stopParsing()

      // Should NOT have any segments that are just '|' or '| '
      const pipeSegments = parsedSegments.filter(s => /^\|[\s]*$/.test(s.segment))


      expect(pipeSegments.length).toBe(0)
    })

    it('should suppress delimiter row content', async () => {
      parser.parseToken('| A |\n')
      parser.parseToken('|---|\n')
      parser.parseToken('| B |\n')
      parser.stopParsing()

      // Should NOT have any segments containing '---'
      const delimiterSegments = parsedSegments.filter(s => s.segment.includes('---'))


      expect(delimiterSegments.length).toBe(0)
    })

    it('should handle inline code in full table structure', async () => {
      parser.parseToken('| Header |\n')
      parser.parseToken('|--------|\n')
      parser.parseToken('| `code` |\n')
      parser.stopParsing()

      // Should have code segment with proper style
      const codeSegments = parsedSegments.filter(s => s.styles && s.styles.includes('code'))


      expect(codeSegments.length).toBeGreaterThan(0)
      // Code should be stripped of backticks
      const hasStrippedCode = codeSegments.some(s => s.segment.trim() === 'code')
      expect(hasStrippedCode).toBe(true)
    })
  })
})
