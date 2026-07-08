import { Fragment, type Mark, type Node as ProseMirrorNode, type Schema } from 'prosemirror-model'
import type { Chunk, ClosedSpan, OpenSpan, Span, SpanType } from '../../../../../src/markdown-stream-parser.ts'

type BlockType = Chunk['block']['type']
type ListMetadata = NonNullable<Chunk['block']['list']>
type ListFrame = {
    type: ListMetadata['type']
    depth: number
    order: number
    items: ProseMirrorNode[]
}
type CellGroup = {
    cellId: string
    columnIndex: number
    type: 'table_header_cell' | 'table_cell'
    align?: 'left' | 'center' | 'right'
    chunks: Chunk[]
}
type MarkRange = {
    type: SpanType
    start: number
    end: number
}

export function isChunkBeforeBacktrack(chunk: Chunk, backtrackOffset: number): boolean {
    return chunk.offset + chunk.length <= backtrackOffset
}

export function applyStreamingChunkToBuffer(buffer: Chunk[], chunk: Chunk): Chunk[] {
    const next = chunk.backtrackOffset === undefined
        ? buffer
        : buffer.filter(bufferedChunk => isChunkBeforeBacktrack(bufferedChunk, chunk.backtrackOffset!))
    return [...next, chunk]
}

export function sanitizeLinkHref(rawHref: string): string | null {
    const href = rawHref.trim()
    if (!href) return null

    try {
        const url = new URL(href)
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
            ? href
            : null
    } catch {
        return null
    }
}

export function sanitizeImageSrc(rawSrc: string): string | null {
    const src = rawSrc.trim()
    if (!src || src.startsWith('//')) return null
    if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) return src

    try {
        const url = new URL(src)
        if (url.protocol === 'http:' || url.protocol === 'https:') return src
        if (url.protocol === 'data:' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) return src
        return null
    } catch {
        return null
    }
}

export function groupChunksIntoBlocks(chunks: Chunk[]): Chunk[][] {
    const blocks: Chunk[][] = []
    let currentBlock: Chunk[] = []
    let lastBlockType: BlockType | undefined
    let lastBlockLevel: number | undefined
    let lastTableId: string | undefined
    let lastListDepth: number | undefined
    let lastListType: ListMetadata['type'] | undefined
    let lastOffset = -1

    for (const chunk of chunks) {
        const blockType = chunk.block.type
        const blockLevel = chunk.block.level
        const tableId = chunk.block.table?.tableId
        const listDepth = chunk.block.list?.depth
        const listType = chunk.block.list?.type
        let isNewBlock = false

        if (
            blockType !== lastBlockType
            && !(isTableCellBlockType(blockType) && isTableCellBlockType(lastBlockType) && tableId === lastTableId)
        ) {
            isNewBlock = true
        } else if (tableId !== lastTableId) {
            isNewBlock = true
        } else if (blockType === 'heading' && blockLevel !== lastBlockLevel) {
            isNewBlock = true
        } else if (blockType === 'list_item' && (listDepth !== lastListDepth || listType !== lastListType)) {
            isNewBlock = true
        } else if (blockType === 'list_item' && lastOffset >= 0) {
            const previousChunk = currentBlock[currentBlock.length - 1]
            if (previousChunk?.text.endsWith('\n') && chunk.text.trim().length > 0) {
                isNewBlock = true
            }
        }

        if (isNewBlock && currentBlock.length > 0) {
            blocks.push(currentBlock)
            currentBlock = []
        }

        currentBlock.push(chunk)
        lastBlockType = blockType
        lastBlockLevel = blockLevel
        lastTableId = tableId
        lastListDepth = listDepth
        lastListType = listType
        lastOffset = chunk.offset + chunk.length
    }

    if (currentBlock.length > 0) blocks.push(currentBlock)
    return blocks
}

export function buildInlineContent(schema: Schema, blockChunks: Chunk[]): ProseMirrorNode[] {
    const nodes: ProseMirrorNode[] = []
    const chunks = trimTrailingNewline(blockChunks)
    const closedSpans = chunks.flatMap(chunk => [...chunk.contained, ...chunk.closing])
    const imageSpans = dedupeClosedSpans(closedSpans.filter((span): span is ClosedSpan & { type: 'image'; src: string; alt?: string } => span.type === 'image'))
    const markRanges = buildMarkRanges(chunks, closedSpans)
    const textRuns = buildTextRuns(chunks, closedSpans, markRanges, imageSpans)

    for (const run of textRuns) {
        if (run.image) {
            const src = sanitizeImageSrc(run.image.src)
            if (src) {
                nodes.push(schema.nodes.image.create({ src, alt: run.image.alt ?? null }))
                continue
            }
        }

        if (!run.text) continue
        const marks = createMarksForRange(schema, closedSpans, markRanges, run.start, run.end)
        nodes.push(marks.length > 0 ? schema.text(run.text, marks) : schema.text(run.text))
    }

    return nodes
}

export function buildContentFromChunks(schema: Schema, chunks: Chunk[]): Fragment {
    const blocks = groupChunksIntoBlocks(chunks)
    const nodes: ProseMirrorNode[] = []
    let listFrames: ListFrame[] = []

    function flushLists(toDepth = -1): void {
        while (listFrames.length > 0 && listFrames[listFrames.length - 1].depth > toDepth) {
            const frame = listFrames.pop()!
            const listNode = createListNode(schema, frame)
            if (listFrames.length > 0) {
                const parent = listFrames[listFrames.length - 1]
                const lastItem = parent.items.pop()
                if (lastItem) {
                    parent.items.push(appendBlockToListItem(schema, lastItem, listNode))
                } else {
                    parent.items.push(schema.nodes.list_item.create(null, listNode))
                }
            } else {
                nodes.push(listNode)
            }
        }
    }

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]
        const firstChunk = block[0]
        const nextBlock = blocks[index + 1]

        try {
            if (firstChunk?.block.type === 'list_item' && firstChunk.block.list) {
                const list = firstChunk.block.list
                flushLists(list.depth - 1)
                let frame = listFrames[listFrames.length - 1]
                if (!frame || frame.depth !== list.depth || frame.type !== list.type) {
                    frame = {
                        type: list.type,
                        depth: list.depth,
                        order: list.ordinal ?? 1,
                        items: [],
                    }
                    listFrames.push(frame)
                }
                frame.items.push(createListItemNode(schema, block, list))
                if (nextBlock?.[0]?.block.list === undefined) flushLists()
                continue
            }

            flushLists()

            if (isTableCellBlockType(firstChunk?.block.type)) {
                const tableBlocks = [block]
                const tableId = firstChunk?.block.table?.tableId
                while (blocks[index + 1]?.[0]?.block.table?.tableId === tableId) {
                    tableBlocks.push(blocks[++index])
                }
                nodes.push(createTableNode(schema, tableBlocks.flat()))
                continue
            }

            nodes.push(createBlockNode(schema, block))
        } catch {
            flushLists()
            nodes.push(schema.nodes.paragraph.create(null, createPlainTextContent(schema, block)))
        }
    }

    flushLists()
    return nodes.length > 0 ? Fragment.fromArray(nodes) : Fragment.from(schema.nodes.paragraph.create())
}

export function buildDocFromChunks(schema: Schema, chunks: Chunk[]): ProseMirrorNode {
    return schema.nodes.doc.create(null, buildContentFromChunks(schema, chunks))
}

function createBlockNode(schema: Schema, block: Chunk[]): ProseMirrorNode {
    const first = block[0]
    const inlineContent = buildInlineContent(schema, block)

    switch (first?.block.type) {
        case 'heading':
            return schema.nodes.heading.create({ level: first.block.level ?? 1 }, inlineContent)
        case 'code_block':
            return schema.nodes.code_block.create(
                { language: first.block.language ?? '' },
                createTextNodeOrNull(schema, trimTrailingNewline(block).map(chunk => chunk.text).join('')),
            )
        case 'blockquote':
            return schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, inlineContent))
        case 'paragraph':
        case undefined:
        default:
            return schema.nodes.paragraph.create(null, inlineContent)
    }
}

function createListItemNode(schema: Schema, block: Chunk[], list: ListMetadata): ProseMirrorNode {
    const paragraph = schema.nodes.paragraph.create(null, buildInlineContent(schema, block))
    return schema.nodes.list_item.create({ task: list.task ?? null }, paragraph)
}

function createListNode(schema: Schema, frame: ListFrame): ProseMirrorNode {
    const type = frame.type === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list
    return frame.type === 'ordered'
        ? type.create({ order: frame.order }, frame.items)
        : type.create(null, frame.items)
}

function appendBlockToListItem(schema: Schema, item: ProseMirrorNode, block: ProseMirrorNode): ProseMirrorNode {
    return schema.nodes.list_item.create(item.attrs, item.content.append(Fragment.from(block)))
}

function createTableNode(schema: Schema, chunks: Chunk[]): ProseMirrorNode {
    const rows = buildTableRows(chunks)
    const rowNodes = rows.map(row => {
        const cellNodes = row.cells.map(cell => {
            const cellType = cell.type === 'table_header_cell'
                ? schema.nodes.table_header_cell
                : schema.nodes.table_cell
            return cellType.create({ align: cell.align ?? null }, buildInlineContent(schema, cell.chunks))
        })
        return schema.nodes.table_row.create(null, cellNodes)
    })
    return schema.nodes.table.create(null, rowNodes)
}

function buildTableRows(chunks: Chunk[]): Array<{ rowIndex: number; cells: CellGroup[] }> {
    const rows = new Map<number, Map<string, CellGroup>>()

    for (const chunk of chunks) {
        const table = chunk.block.table
        if (!table) continue

        let row = rows.get(table.rowIndex)
        if (!row) {
            row = new Map<string, CellGroup>()
            rows.set(table.rowIndex, row)
        }

        let cell = row.get(table.cellId)
        if (!cell) {
            cell = {
                cellId: table.cellId,
                columnIndex: table.columnIndex,
                type: chunk.block.type === 'table_header_cell' ? 'table_header_cell' : 'table_cell',
                align: table.align,
                chunks: [],
            }
            row.set(table.cellId, cell)
        }

        cell.chunks.push(chunk)
    }

    return [...rows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([rowIndex, cells]) => ({
            rowIndex,
            cells: [...cells.values()].sort((a, b) => a.columnIndex - b.columnIndex),
        }))
}

function buildTextRuns(
    chunks: Chunk[],
    spans: ClosedSpan[],
    markRanges: MarkRange[],
    imageSpans: Array<ClosedSpan & { type: 'image'; src: string; alt?: string }>,
): Array<{ start: number; end: number; text: string; image?: Span & { type: 'image' } }> {
    const runs: Array<{ start: number; end: number; text: string; image?: Span & { type: 'image' } }> = []

    for (const chunk of chunks) {
        const chunkStart = chunk.offset
        const chunkEnd = chunk.offset + chunk.length
        const boundaries = new Set<number>([chunkStart, chunkEnd])

        for (const span of spans) {
            const spanStart = span.offset
            const spanEnd = span.offset + span.length
            if (spanStart > chunkStart && spanStart < chunkEnd) boundaries.add(spanStart)
            if (spanEnd > chunkStart && spanEnd < chunkEnd) boundaries.add(spanEnd)
        }
        for (const range of markRanges) {
            if (range.start > chunkStart && range.start < chunkEnd) boundaries.add(range.start)
            if (range.end > chunkStart && range.end < chunkEnd) boundaries.add(range.end)
        }

        const sortedBoundaries = [...boundaries].sort((a, b) => a - b)
        for (let index = 0; index < sortedBoundaries.length - 1; index++) {
            const start = sortedBoundaries[index]
            const end = sortedBoundaries[index + 1]
            if (start === end) continue
            const image = imageSpans.find(span => span.offset === start && span.offset + span.length === end)
            runs.push({
                start,
                end,
                text: chunk.text.slice(start - chunk.offset, end - chunk.offset),
                image,
            })
        }
    }

    return runs
}

function buildMarkRanges(chunks: Chunk[], spans: ClosedSpan[]): MarkRange[] {
    const ranges: MarkRange[] = []
    const openSpans: OpenSpan[] = []
    const blockEnd = chunks.reduce((max, chunk) => Math.max(max, chunk.offset + chunk.length), 0)

    for (const span of spans) {
        if (span.type === 'link' || span.type === 'image') continue
        ranges.push({ type: span.type, start: span.offset, end: span.offset + span.length })
    }

    for (const chunk of chunks) {
        for (const span of chunk.opening) {
            if (span.type === 'link' || span.type === 'image') continue
            openSpans.push(span)
        }

        for (const span of chunk.closing) {
            if (span.type === 'link' || span.type === 'image') continue
            const openIndex = openSpans.findIndex(openSpan =>
                openSpan.type === span.type && openSpan.openOffset === span.offset
            )
            if (openIndex === -1) continue

            ranges.push({
                type: span.type,
                start: openSpans[openIndex].openOffset,
                end: span.offset + span.length,
            })
            openSpans.splice(openIndex, 1)
        }
    }

    for (const span of openSpans) {
        if (span.openOffset < blockEnd) {
            ranges.push({ type: span.type, start: span.openOffset, end: blockEnd })
        }
    }

    return ranges
}

function createMarksForRange(schema: Schema, spans: ClosedSpan[], markRanges: MarkRange[], start: number, end: number): Mark[] {
    const marks: Mark[] = []
    const activeTypes = new Set<SpanType>()

    for (const span of dedupeClosedSpans(spans)) {
        if (span.type === 'image') continue
        if (span.offset >= end || span.offset + span.length <= start) continue

        if (span.type === 'link') {
            const href = sanitizeLinkHref(span.url)
            if (href) marks.push(schema.marks.link.create({ href }))
        }
    }

    for (const range of markRanges) {
        if (range.type === 'link' || range.type === 'image') continue
        if (range.start >= end || range.end <= start) continue

        if (activeTypes.has(range.type)) continue
        activeTypes.add(range.type)
        const mark = createMarkForSpanType(schema, range.type)
        if (mark) marks.push(mark)
    }

    return marks
}

function createMarkForSpanType(schema: Schema, type: SpanType): Mark | null {
    switch (type) {
        case 'bold':
            return schema.marks.strong.create()
        case 'italic':
            return schema.marks.em.create()
        case 'code':
            return schema.marks.code.create()
        case 'strikethrough':
            return schema.marks.strikethrough.create()
        default:
            return null
    }
}

function dedupeClosedSpans<T extends ClosedSpan>(spans: T[]): T[] {
    const seen = new Set<string>()
    return spans.filter(span => {
        const key = `${span.type}:${span.offset}:${span.length}:${'url' in span ? span.url : ''}:${'src' in span ? span.src : ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function trimTrailingNewline(chunks: Chunk[]): Chunk[] {
    if (chunks.length === 0) return chunks
    const trimmed = [...chunks]
    const last = trimmed[trimmed.length - 1]
    if (!last.text.endsWith('\n')) return trimmed

    trimmed[trimmed.length - 1] = {
        ...last,
        text: last.text.slice(0, -1),
        length: Math.max(0, last.length - 1),
    }
    return trimmed
}

function createTextNodeOrNull(schema: Schema, text: string): ProseMirrorNode | null {
    return text ? schema.text(text) : null
}

function createPlainTextContent(schema: Schema, block: Chunk[]): ProseMirrorNode[] {
    const text = trimTrailingNewline(block).map(chunk => chunk.text).join('')
    return text ? [schema.text(text)] : []
}

function isTableCellBlockType(blockType: string | undefined): boolean {
    return blockType === 'table_header_cell' || blockType === 'table_cell'
}
