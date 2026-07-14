import { describe, expect, it } from 'vitest'
import type { Chunk } from '../../../../../src/markdown-stream-parser.ts'
import { schema } from './schema.ts'
import {
    applyStreamingChunkToBuffer,
    buildDocFromChunks,
    buildInlineContent,
    groupChunksIntoBlocks,
    isChunkBeforeBacktrack,
    sanitizeImageSrc,
    sanitizeLinkHref,
} from './stream-assembly.ts'

function chunk(overrides: Partial<Chunk> & Pick<Chunk, 'text' | 'offset'>): Chunk {
    return {
        text: overrides.text,
        offset: overrides.offset,
        length: overrides.length ?? overrides.text.length,
        block: overrides.block ?? { type: 'paragraph' },
        opening: overrides.opening ?? [],
        closing: overrides.closing ?? [],
        contained: overrides.contained ?? [],
        backtrackOffset: overrides.backtrackOffset,
        recovery: overrides.recovery,
        original: overrides.original,
    }
}

describe('stream assembly helpers', () => {
    it('shares the legacy backtrack predicate', () => {
        const first = chunk({ text: 'hello', offset: 0 })
        const stale = chunk({ text: ' world', offset: 5 })
        const replacement = chunk({ text: ' there', offset: 5, backtrackOffset: 5 })

        expect(isChunkBeforeBacktrack(first, 5)).toBe(true)
        expect(isChunkBeforeBacktrack(stale, 5)).toBe(false)
        expect(applyStreamingChunkToBuffer([first, stale], replacement)).toEqual([first, replacement])
    })

    it('sanitizes link and image urls', () => {
        expect(sanitizeLinkHref('https://example.com')).toBe('https://example.com')
        expect(sanitizeLinkHref('mailto:test@example.com')).toBe('mailto:test@example.com')
        expect(sanitizeLinkHref('javascript:alert(1)')).toBeNull()
        expect(sanitizeImageSrc('/asset.png')).toBe('/asset.png')
        expect(sanitizeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
        expect(sanitizeImageSrc('//example.com/image.png')).toBeNull()
        expect(sanitizeImageSrc('data:text/html;base64,AAAA')).toBeNull()
        expect(sanitizeImageSrc('image.png')).toBe('image.png')
        expect(sanitizeImageSrc('../image.png')).toBe('../image.png')
        expect(sanitizeImageSrc('?cache=1')).toBeNull()
        expect(sanitizeImageSrc('#fragment')).toBeNull()
        expect(sanitizeImageSrc('JaVaScRiPt:alert(1)')).toBeNull()
        expect(sanitizeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
        expect(sanitizeImageSrc('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA')
    })

    it('builds marks and rejects unsafe links', () => {
        const safe = chunk({
            text: 'safe bad',
            offset: 0,
            contained: [
                { type: 'link', offset: 0, length: 4, url: 'https://example.com' },
                { type: 'link', offset: 5, length: 3, url: 'javascript:alert(1)' },
            ],
        })

        const nodes = buildInlineContent(schema, [safe])
        expect(nodes.map(node => node.text).join('')).toBe('safe bad')
        expect(nodes[0].marks[0]?.type.name).toBe('link')
        expect(nodes[nodes.length - 1].marks).toHaveLength(0)
    })

    it('styles a span that opens in one chunk and closes in a later chunk', () => {
        const nodes = buildInlineContent(schema, [
            chunk({
                text: 'bo',
                offset: 0,
                opening: [{ type: 'bold', openOffset: 0 }],
            }),
            chunk({
                text: 'ld',
                offset: 2,
            }),
            chunk({
                text: ' text',
                offset: 4,
                closing: [{ type: 'bold', offset: 0, length: 4 }],
            }),
        ])

        const textNodes = nodes.filter(node => node.isText)
        expect(textNodes.map(node => node.text).join('')).toBe('bold text')
        expect(textNodes.slice(0, 2).every(node => node.marks.some(mark => mark.type.name === 'strong'))).toBe(true)
        expect(textNodes[textNodes.length - 1].marks.some(mark => mark.type.name === 'strong')).toBe(false)
    })

    it('styles an unclosed span through the end of the current buffer', () => {
        const nodes = buildInlineContent(schema, [
            chunk({
                text: 'plain ',
                offset: 0,
            }),
            chunk({
                text: 'bold',
                offset: 6,
                opening: [{ type: 'bold', openOffset: 6 }],
            }),
        ])

        expect(nodes.map(node => node.text).join('')).toBe('plain bold')
        expect(nodes[0].marks.some(mark => mark.type.name === 'strong')).toBe(false)
        expect(nodes[nodes.length - 1].marks.some(mark => mark.type.name === 'strong')).toBe(true)
    })

    it('creates image nodes only for safe image sources', () => {
        const nodes = buildInlineContent(schema, [
            chunk({
                text: 'logo evil',
                offset: 0,
                contained: [
                    { type: 'image', offset: 0, length: 4, src: '/logo.png', alt: 'Logo' },
                    { type: 'image', offset: 5, length: 4, src: 'javascript:alert(1)', alt: 'Bad' },
                ],
            }),
        ])

        expect(nodes[0].type.name).toBe('image')
        expect(nodes[0].attrs.src).toBe('/logo.png')
        expect(nodes[nodes.length - 1].text).toBe('evil')
    })

    it('groups list items by depth and type boundaries', () => {
        const blocks = groupChunksIntoBlocks([
            chunk({ text: 'one\n', offset: 0, block: { type: 'list_item', list: { type: 'unordered', depth: 0, marker: '-' } } }),
            chunk({ text: 'two', offset: 4, block: { type: 'list_item', list: { type: 'unordered', depth: 0, marker: '-' } } }),
            chunk({ text: 'nested', offset: 7, block: { type: 'list_item', list: { type: 'unordered', depth: 1, marker: '-' } } }),
        ])

        expect(blocks).toHaveLength(3)
    })

    it('builds lists, task items, tables, and code blocks', () => {
        const doc = buildDocFromChunks(schema, [
            chunk({ text: 'Task', offset: 0, block: { type: 'list_item', list: { type: 'unordered', depth: 0, marker: '-', task: { checked: true } } } }),
            chunk({ text: 'Head', offset: 4, block: { type: 'table_header_cell', table: { tableId: 't1', rowIndex: 0, columnIndex: 0, cellId: 't1:0:0' } } }),
            chunk({ text: 'Cell', offset: 8, block: { type: 'table_cell', table: { tableId: 't1', rowIndex: 1, columnIndex: 0, cellId: 't1:1:0' } } }),
            chunk({ text: 'const x = 1\n', offset: 12, block: { type: 'code_block', language: 'ts' } }),
        ])

        expect(doc.child(0).type.name).toBe('bullet_list')
        expect(doc.child(0).child(0).attrs.task).toEqual({ checked: true })
        expect(doc.child(1).type.name).toBe('table')
        expect(doc.child(2).type.name).toBe('code_block')
        expect(doc.child(2).attrs.language).toBe('ts')
        expect(() => doc.check()).not.toThrow()
    })

    it('preserves same-depth siblings, nested siblings, and the parent list on return', () => {
        const list = (text: string, offset: number, depth: number, type: 'ordered' | 'unordered' = 'unordered', ordinal?: number) => chunk({
            text,
            offset,
            block: { type: 'list_item', list: { type, depth, marker: type === 'ordered' ? '.' : '-', ordinal } },
        })
        const doc = buildDocFromChunks(schema, [
            list('one\n', 0, 0), list('child a\n', 4, 1), list('child b\n', 12, 1), list('two', 20, 0),
            list('numbered', 23, 0, 'ordered', 3),
        ])
        expect(doc.child(0).type.name).toBe('bullet_list')
        expect(doc.child(0).childCount).toBe(2)
        const nested = doc.child(0).child(0).lastChild!
        expect(nested.type.name).toBe('bullet_list')
        expect(nested.childCount).toBe(2)
        expect(doc.child(1).type.name).toBe('ordered_list')
        expect(doc.child(1).attrs.order).toBe(3)
        expect(() => doc.check()).not.toThrow()
    })

    it('projects a closed image span across chunks once while retaining surrounding text', () => {
        const nodes = buildInlineContent(schema, [
            chunk({ text: 'before lo', offset: 0 }),
            chunk({ text: 'go after', offset: 9, closing: [{ type: 'image', offset: 7, length: 4, src: 'image.png', alt: 'logo' }] }),
        ])
        expect(nodes.map(node => node.isText ? node.text : `[${node.type.name}]`).join('')).toBe('before [image] after')
        expect(nodes.filter(node => node.type.name === 'image')).toHaveLength(1)
    })

    it('falls back instead of throwing for malformed block states', () => {
        const doc = buildDocFromChunks(schema, [
            chunk({ text: '', offset: 0, block: { type: 'table_cell' } }),
        ])

        expect(doc.type.name).toBe('doc')
        expect(doc.childCount).toBeGreaterThan(0)
        expect(() => doc.check()).not.toThrow()
    })
})
