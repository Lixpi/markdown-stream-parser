import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model'

const paragraphDOM: DOMOutputSpec = ['p', 0]
const blockquoteDOM: DOMOutputSpec = ['blockquote', 0]
const bulletListDOM: DOMOutputSpec = ['ul', 0]
const tableDOM: DOMOutputSpec = ['table', ['tbody', 0]]
const tableRowDOM: DOMOutputSpec = ['tr', 0]
const emDOM: DOMOutputSpec = ['em', 0]
const strongDOM: DOMOutputSpec = ['strong', 0]
const codeDOM: DOMOutputSpec = ['code', 0]
const strikethroughDOM: DOMOutputSpec = ['s', 0]

export const nodes = {
    doc: {
        content: 'block+',
    } as NodeSpec,

    paragraph: {
        content: 'inline*',
        group: 'block',
        toDOM() { return paragraphDOM },
    } as NodeSpec,

    heading: {
        attrs: { level: { default: 1 } },
        content: 'inline*',
        group: 'block',
        defining: true,
        toDOM(node) {
            const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1))
            return [`h${level}`, 0]
        },
    } as NodeSpec,

    code_block: {
        attrs: { language: { default: '' } },
        content: 'text*',
        marks: '',
        group: 'block',
        code: true,
        defining: true,
        toDOM(node) {
            const attrs: Record<string, string> = {}
            if (node.attrs.language) attrs['data-language'] = node.attrs.language
            return ['pre', attrs, ['code', 0]]
        },
    } as NodeSpec,

    blockquote: {
        content: 'block+',
        group: 'block',
        defining: true,
        toDOM() { return blockquoteDOM },
    } as NodeSpec,

    bullet_list: {
        content: 'list_item+',
        group: 'block',
        toDOM() { return bulletListDOM },
    } as NodeSpec,

    ordered_list: {
        attrs: { order: { default: 1 } },
        content: 'list_item+',
        group: 'block',
        toDOM(node) {
            const order = Number(node.attrs.order) || 1
            return order === 1 ? ['ol', 0] : ['ol', { start: order }, 0]
        },
    } as NodeSpec,

    list_item: {
        attrs: { task: { default: null } },
        content: 'block+',
        defining: true,
        toDOM(node) {
            const task = node.attrs.task as { checked: boolean } | null
            if (!task) return ['li', 0]
            return ['li', { 'data-task': task.checked ? 'checked' : 'unchecked' }, 0]
        },
    } as NodeSpec,

    table: {
        content: 'table_row+',
        group: 'block',
        toDOM() { return tableDOM },
    } as NodeSpec,

    table_row: {
        content: '(table_header_cell|table_cell)+',
        toDOM() { return tableRowDOM },
    } as NodeSpec,

    table_header_cell: {
        attrs: { align: { default: null } },
        content: 'inline*',
        toDOM(node) { return createTableCellDOM('th', node.attrs.align) },
    } as NodeSpec,

    table_cell: {
        attrs: { align: { default: null } },
        content: 'inline*',
        toDOM(node) { return createTableCellDOM('td', node.attrs.align) },
    } as NodeSpec,

    image: {
        inline: true,
        group: 'inline',
        attrs: {
            src: {},
            alt: { default: null },
        },
        draggable: false,
        toDOM(node) {
            const attrs: Record<string, string> = { src: node.attrs.src }
            if (node.attrs.alt) attrs.alt = node.attrs.alt
            return ['img', attrs]
        },
    } as NodeSpec,

    text: {
        group: 'inline',
    } as NodeSpec,
}

export const marks = {
    link: {
        attrs: { href: {} },
        inclusive: false,
        toDOM(node) {
            return ['a', { href: node.attrs.href, rel: 'noopener noreferrer' }, 0]
        },
    } as MarkSpec,

    em: {
        toDOM() { return emDOM },
    } as MarkSpec,

    strong: {
        toDOM() { return strongDOM },
    } as MarkSpec,

    code: {
        toDOM() { return codeDOM },
    } as MarkSpec,

    strikethrough: {
        toDOM() { return strikethroughDOM },
    } as MarkSpec,
}

function createTableCellDOM(tag: 'th' | 'td', align: unknown): DOMOutputSpec {
    if (align === 'left' || align === 'center' || align === 'right') {
        return [tag, { style: `text-align: ${align}` }, 0]
    }
    return [tag, 0]
}

export const schema = new Schema({ nodes, marks })

export function createEmptyDoc() {
    return schema.nodes.doc.create(null, schema.nodes.paragraph.create())
}
