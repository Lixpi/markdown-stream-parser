import { Fragment, type Mark, type Node as ProseMirrorNode, type Schema } from 'prosemirror-model'
import type { Chunk, ClosedSpan, OpenSpan, SpanType } from '../../../../../src/markdown-stream-parser.ts'

type ListMetadata = NonNullable<Chunk['block']['list']>
type ListFrame = { type: ListMetadata['type']; depth: number; order: number; items: ProseMirrorNode[] }
type CellGroup = { cellId: string; columnIndex: number; type: 'table_header_cell' | 'table_cell'; align?: 'left' | 'center' | 'right'; chunks: Chunk[] }
type MarkRange = { type: Exclude<SpanType, 'link' | 'image'>; start: number; end: number }
type TextRun = { start: number; end: number; text: string; image?: ClosedSpan & { type: 'image'; src: string; alt?: string } }

export function isChunkBeforeBacktrack(chunk: Chunk, backtrackOffset: number): boolean {
    return chunk.offset + chunk.length <= backtrackOffset
}

export function applyStreamingChunkToBuffer(buffer: Chunk[], chunk: Chunk): Chunk[] {
    const next = chunk.backtrackOffset === undefined ? buffer : buffer.filter(item => isChunkBeforeBacktrack(item, chunk.backtrackOffset!))
    return [...next, chunk]
}

export function sanitizeLinkHref(rawHref: string): string | null {
    const href = rawHref.trim()
    if (!href) return null
    try {
        const url = new URL(href)
        return ['http:', 'https:', 'mailto:'].includes(url.protocol.toLowerCase()) ? href : null
    } catch { return null }
}

// SVG data URLs are intentionally excluded: SVG is an active document format, not a raster image.
const safeDataImage = /^data:image\/(?:png|apng|gif|jpe?g|webp|avif);base64,[a-z0-9+/]*={0,2}$/i

export function sanitizeImageSrc(rawSrc: string): string | null {
    const src = rawSrc.trim()
    if (!src || src.startsWith('//') || src.startsWith('?') || src.startsWith('#')) return null
    if (src.startsWith('/') || /^(?:\.\.?\/)?[^:/?#][^:]*$/u.test(src)) return src
    if (safeDataImage.test(src)) return src
    try {
        const url = new URL(src)
        return ['http:', 'https:'].includes(url.protocol.toLowerCase()) ? src : null
    } catch { return null }
}

export function groupChunksIntoBlocks(chunks: Chunk[]): Chunk[][] {
    const result: Chunk[][] = []
    let current: Chunk[] = []
    for (const chunk of chunks) {
        const previous = current.at(-1)
        const typeChanged = previous && chunk.block.type !== previous.block.type && !(isTableCellBlockType(chunk.block.type) && isTableCellBlockType(previous.block.type) && chunk.block.table?.tableId === previous.block.table?.tableId)
        const tableChanged = previous && chunk.block.table?.tableId !== previous.block.table?.tableId
        const headingChanged = previous && chunk.block.type === 'heading' && chunk.block.level !== previous.block.level
        const listChanged = previous && chunk.block.type === 'list_item' && (chunk.block.list?.depth !== previous.block.list?.depth || chunk.block.list?.type !== previous.block.list?.type)
        const nextListItem = previous && chunk.block.type === 'list_item' && previous.text.endsWith('\n') && chunk.text.trim().length > 0
        if ((typeChanged || tableChanged || headingChanged || listChanged || nextListItem) && current.length) {
            result.push(current)
            current = []
        }
        current.push(chunk)
    }
    if (current.length) result.push(current)
    return result
}

export function buildInlineContent(schema: Schema, blockChunks: Chunk[]): ProseMirrorNode[] {
    const chunks = trimTrailingNewline(blockChunks)
    const closed = dedupeClosedSpans(chunks.flatMap(chunk => [...chunk.contained, ...chunk.closing]))
    const marks = buildMarkRanges(chunks, closed)
    return buildTextRuns(chunks, closed, marks).flatMap(run => {
        if (run.image) {
            const src = sanitizeImageSrc(run.image.src)
            if (src && schema.nodes.image?.isInline) return [schema.nodes.image.create({ src, alt: run.image.alt ?? null })]
        }
        if (!run.text) return []
        const active = createMarksForRange(schema, closed, marks, run.start, run.end)
        return [schema.text(run.text, active)]
    })
}

/** Schema-parameterized content builder. Schemas without optional list/table/image nodes degrade to valid paragraphs/text. */
export function buildContentFromChunks(schema: Schema, chunks: Chunk[]): Fragment {
    const nodes: ProseMirrorNode[] = []
    const frames: ListFrame[] = []
    const flush = (minimumDepth = -1) => {
        while (frames.length && frames.at(-1)!.depth >= minimumDepth) {
            const frame = frames.pop()!
            const listNode = createListNode(schema, frame)
            if (!listNode) {
                nodes.push(...frame.items.map(item => schema.nodes.paragraph.create(null, item.textContent ? schema.text(item.textContent) : null)))
            } else if (frames.length) {
                const parent = frames.at(-1)!
                const item = parent.items.pop()
                parent.items.push(item ? appendBlockToListItem(schema, item, listNode) : schema.nodes.list_item.create(null, listNode))
            } else nodes.push(listNode)
        }
    }
    const blocks = groupChunksIntoBlocks(chunks)
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]
        const first = block[0]
        try {
            if (first?.block.type === 'list_item' && first.block.list) {
                const list = first.block.list
                // Keep same-depth siblings; close only descendants. A different list type replaces the frame.
                while (frames.length && frames.at(-1)!.depth > list.depth) flush(frames.at(-1)!.depth)
                if (frames.at(-1)?.depth === list.depth && frames.at(-1)?.type !== list.type) flush(list.depth)
                if (!frames.at(-1) || frames.at(-1)!.depth !== list.depth) frames.push({ type: list.type, depth: list.depth, order: list.ordinal ?? 1, items: [] })
                frames.at(-1)!.items.push(createListItemNode(schema, block, list))
                if (!blocks[index + 1]?.[0]?.block.list) flush(0)
                continue
            }
            flush(0)
            if (isTableCellBlockType(first?.block.type)) {
                const tableId = first.block.table?.tableId
                const tableBlocks = [block]
                while (tableId !== undefined && blocks[index + 1]?.[0]?.block.table?.tableId === tableId) tableBlocks.push(blocks[++index])
                const table = createTableNode(schema, tableBlocks.flat())
                nodes.push(table ?? fallbackParagraph(schema, tableBlocks.flat()))
            } else nodes.push(createBlockNode(schema, block))
        } catch (error) {
            console.warn('Unexpected ProseMirror stream assembly failure; using plain-text fallback.', error)
            flush(0)
            nodes.push(fallbackParagraph(schema, block))
        }
    }
    flush(0)
    return nodes.length ? Fragment.fromArray(nodes) : Fragment.from(schema.nodes.paragraph.create())
}

export function buildDocFromChunks(schema: Schema, chunks: Chunk[]): ProseMirrorNode {
    const doc = schema.nodes.doc.createAndFill(null, buildContentFromChunks(schema, chunks))
    if (!doc) throw new Error('Schema cannot create a valid document from streaming content')
    doc.check()
    return doc
}

function createBlockNode(schema: Schema, block: Chunk[]): ProseMirrorNode {
    const first = block[0]
    const inline = buildInlineContent(schema, block)
    const node = first?.block.type === 'heading' ? schema.nodes.heading?.createAndFill({ level: first.block.level ?? 1 }, inline)
        : first?.block.type === 'code_block' ? schema.nodes.code_block?.createAndFill({ language: first.block.language ?? '' }, createTextNodeOrNull(schema, trimTrailingNewline(block).map(c => c.text).join('')))
        : first?.block.type === 'blockquote' ? schema.nodes.blockquote?.createAndFill(null, schema.nodes.paragraph.create(null, inline))
        : schema.nodes.paragraph.createAndFill(null, inline)
    return node ?? fallbackParagraph(schema, block)
}

function createListItemNode(schema: Schema, block: Chunk[], list: ListMetadata): ProseMirrorNode {
    return schema.nodes.list_item.createAndFill({ task: list.task ?? null }, schema.nodes.paragraph.create(null, buildInlineContent(schema, block))) ?? fallbackParagraph(schema, block)
}

function createListNode(schema: Schema, frame: ListFrame): ProseMirrorNode | null {
    const type = frame.type === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list
    return type?.createAndFill(frame.type === 'ordered' ? { order: frame.order } : null, frame.items) ?? null
}

function appendBlockToListItem(schema: Schema, item: ProseMirrorNode, block: ProseMirrorNode): ProseMirrorNode {
    return schema.nodes.list_item.createAndFill(item.attrs, item.content.append(Fragment.from(block))) ?? item
}

function createTableNode(schema: Schema, chunks: Chunk[]): ProseMirrorNode | null {
    if (!schema.nodes.table || !schema.nodes.table_row || !schema.nodes.table_cell || !schema.nodes.table_header_cell) return null
    const rows = buildTableRows(chunks)
    if (!rows.length || rows.some(row => !row.cells.length)) return null
    const rowNodes = rows.map(row => {
        const cells = row.cells
            .map(cell => (cell.type === 'table_header_cell' ? schema.nodes.table_header_cell : schema.nodes.table_cell).createAndFill({ align: cell.align ?? null }, buildInlineContent(schema, cell.chunks)))
            .filter((node): node is ProseMirrorNode => node !== null)
        return schema.nodes.table_row.createAndFill(null, cells)
    })
    if (rowNodes.some(node => !node)) return null
    const table = schema.nodes.table.createAndFill(null, rowNodes.filter((node): node is ProseMirrorNode => node !== null))
    if (table) table.check()
    return table
}

function buildTableRows(chunks: Chunk[]): Array<{ rowIndex: number; cells: CellGroup[] }> {
    const rows = new Map<number, Map<string, CellGroup>>()
    for (const chunk of chunks) {
        const meta = chunk.block.table
        if (!meta) continue
        let row = rows.get(meta.rowIndex); if (!row) rows.set(meta.rowIndex, row = new Map())
        let cell = row.get(meta.cellId)
        if (!cell) row.set(meta.cellId, cell = { cellId: meta.cellId, columnIndex: meta.columnIndex, type: chunk.block.type === 'table_header_cell' ? 'table_header_cell' : 'table_cell', align: meta.align, chunks: [] })
        cell.chunks.push(chunk)
    }
    return [...rows].sort(([a], [b]) => a - b).map(([rowIndex, cells]) => ({ rowIndex, cells: [...cells.values()].sort((a, b) => a.columnIndex - b.columnIndex) }))
}

function buildTextRuns(chunks: Chunk[], spans: ClosedSpan[], markRanges: MarkRange[]): TextRun[] {
    const images = spans.filter((span): span is ClosedSpan & { type: 'image'; src: string; alt?: string } => span.type === 'image' && isFullyCovered(chunks, span.offset, span.offset + span.length))
    const boundaries = new Set<number>()
    for (const chunk of chunks) { boundaries.add(chunk.offset); boundaries.add(chunk.offset + chunk.length) }
    for (const span of spans) { boundaries.add(span.offset); boundaries.add(span.offset + span.length) }
    for (const range of markRanges) { boundaries.add(range.start); boundaries.add(range.end) }
    const points = [...boundaries].sort((a, b) => a - b)
    const runs: TextRun[] = []
    for (let i = 0; i < points.length - 1;) {
        const start = points[i], image = images.find(span => span.offset === start)
        const end = image ? image.offset + image.length : points[i + 1]
        const text = textForRange(chunks, start, end)
        runs.push({ start, end, text, image })
        i = image ? points.findIndex(point => point === end) : i + 1
    }
    return runs
}

function textForRange(chunks: Chunk[], start: number, end: number): string {
    return chunks.map(chunk => {
        const from = Math.max(start, chunk.offset), to = Math.min(end, chunk.offset + chunk.length)
        return from < to ? chunk.text.slice(from - chunk.offset, to - chunk.offset) : ''
    }).join('')
}

function isFullyCovered(chunks: Chunk[], start: number, end: number): boolean {
    let cursor = start
    for (const chunk of [...chunks].sort((a, b) => a.offset - b.offset)) {
        if (chunk.offset > cursor) return false
        if (chunk.offset + chunk.length > cursor) cursor = Math.min(end, chunk.offset + chunk.length)
        if (cursor === end) return true
    }
    return false
}

function buildMarkRanges(chunks: Chunk[], spans: ClosedSpan[]): MarkRange[] {
    const ranges = spans.filter(span => span.type !== 'link' && span.type !== 'image').map(span => ({ type: span.type, start: span.offset, end: span.offset + span.length }))
    const open: Array<OpenSpan & { type: MarkRange['type'] }> = [], end = Math.max(0, ...chunks.map(chunk => chunk.offset + chunk.length))
    for (const chunk of chunks) {
        for (const span of chunk.opening) if (span.type !== 'link' && span.type !== 'image') open.push(span as OpenSpan & { type: MarkRange['type'] })
        for (const span of chunk.closing) {
            if (span.type === 'link' || span.type === 'image') continue
            const index = open.findIndex(item => item.type === span.type && item.openOffset === span.offset)
            if (index >= 0) { ranges.push({ type: span.type, start: open[index].openOffset, end: span.offset + span.length }); open.splice(index, 1) }
        }
    }
    return [...ranges, ...open.filter(span => span.openOffset < end).map(span => ({ type: span.type, start: span.openOffset, end }))]
}

function createMarksForRange(schema: Schema, spans: ClosedSpan[], ranges: MarkRange[], start: number, end: number): Mark[] {
    const marks: Mark[] = []
    for (const span of spans) if (span.type === 'link' && span.offset < end && span.offset + span.length > start) { const href = sanitizeLinkHref(span.url); if (href && schema.marks.link) marks.push(schema.marks.link.create({ href })) }
    for (const range of ranges) if (range.start < end && range.end > start) { const mark = createMarkForSpanType(schema, range.type); if (mark && !marks.some(item => item.type === mark.type)) marks.push(mark) }
    return marks
}

function createMarkForSpanType(schema: Schema, type: SpanType): Mark | null {
    const name = type === 'bold' ? 'strong' : type === 'italic' ? 'em' : type
    return name === 'code' || name === 'strikethrough' || name === 'strong' || name === 'em' ? schema.marks[name]?.create() ?? null : null
}

function dedupeClosedSpans<T extends ClosedSpan>(spans: T[]): T[] { const seen = new Set<string>(); return spans.filter(span => { const key = `${span.type}:${span.offset}:${span.length}:${'url' in span ? span.url : ''}:${'src' in span ? span.src : ''}`; if (seen.has(key)) return false; seen.add(key); return true }) }
function trimTrailingNewline(chunks: Chunk[]): Chunk[] { const copy = [...chunks], last = copy.at(-1); if (!last?.text.endsWith('\n')) return copy; copy[copy.length - 1] = { ...last, text: last.text.slice(0, -1), length: Math.max(0, last.length - 1) }; return copy }
function createTextNodeOrNull(schema: Schema, text: string): ProseMirrorNode | null { return text ? schema.text(text) : null }
function fallbackParagraph(schema: Schema, chunks: Chunk[]): ProseMirrorNode { const text = trimTrailingNewline(chunks).map(chunk => chunk.text).join(''); return schema.nodes.paragraph.create(null, text ? schema.text(text) : null) }
function isTableCellBlockType(type: string | undefined): boolean { return type === 'table_header_cell' || type === 'table_cell' }
