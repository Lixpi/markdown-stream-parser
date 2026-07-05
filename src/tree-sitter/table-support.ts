import type { Node } from 'web-tree-sitter'
import type { BlockInfo, ListMetadata, TableAlignment, TableMetadata } from './types.ts'

export function isInsideTableDelimiterRow(node: Node): boolean {
    let current: Node | null = node

    while (current) {
        if (current.type === 'pipe_table_delimiter_row' || current.type === 'pipe_table_delimiter_cell') {
            return true
        }
        current = current.parent
    }

    return false
}

function getEnclosingTable(node: Node): Node | null {
    let current: Node | null = node

    while (current) {
        if (current.type === 'pipe_table') {
            return current
        }
        current = current.parent
    }

    return null
}

function normalizeAlignment(text: string): TableAlignment | undefined {
    const trimmed = text.trim()
    const startsWithColon = trimmed.startsWith(':')
    const endsWithColon = trimmed.endsWith(':')

    if (startsWithColon && endsWithColon) {
        return 'center'
    }
    if (endsWithColon) {
        return 'right'
    }
    if (startsWithColon) {
        return 'left'
    }

    return undefined
}

export function getTableAlignments(tableNode: Node): Array<TableAlignment | undefined> {
    const delimiterRow = tableNode.children.find(child => child.type === 'pipe_table_delimiter_row')
    if (!delimiterRow) {
        return []
    }

    return delimiterRow.children
        .filter(child => child.type === 'pipe_table_delimiter_cell')
        .map(child => normalizeAlignment(child.text))
}

export function getColumnIndex(cellNode: Node): number {
    let count = 0
    let sibling = cellNode.previousSibling

    while (sibling) {
        if (sibling.type === 'pipe_table_cell') {
            count++
        }
        sibling = sibling.previousSibling
    }

    return count
}

export function getRowIndex(rowNode: Node): number {
    let count = 0
    let sibling = rowNode.previousSibling

    while (sibling) {
        if (sibling.type === 'pipe_table_header' || sibling.type === 'pipe_table_row') {
            count++
        }
        sibling = sibling.previousSibling
    }

    return count
}

export function getTableId(tableNode: Node): string {
    return `table:${tableNode.startIndex}`
}

export function getCellId(tableId: string, rowIndex: number, columnIndex: number): string {
    return `${tableId}:${rowIndex}:${columnIndex}`
}

function createTableMetadata(tableNode: Node, rowNode: Node, cellNode: Node): TableMetadata {
    const rowIndex = getRowIndex(rowNode)
    const columnIndex = getColumnIndex(cellNode)
    const tableId = getTableId(tableNode)
    const alignments = getTableAlignments(tableNode)

    return {
        tableId,
        rowIndex,
        columnIndex,
        cellId: getCellId(tableId, rowIndex, columnIndex),
        align: alignments[columnIndex],
    }
}

export function getTableBlockInfo(node: Node, list?: ListMetadata): BlockInfo | null {
    const tableNode = getEnclosingTable(node)
    if (!tableNode) {
        return null
    }

    let current: Node | null = node
    let rowNode: Node | null = null
    let cellNode: Node | null = null
    let isHeaderCell = false

    while (current && current !== tableNode) {
        if (current.type === 'pipe_table_cell' && !cellNode) {
            cellNode = current
        }
        if ((current.type === 'pipe_table_header' || current.type === 'pipe_table_row') && !rowNode) {
            rowNode = current
        }
        if (current.type === 'pipe_table_header') {
            isHeaderCell = true
        }
        current = current.parent
    }

    if (cellNode && rowNode) {
        return {
            type: isHeaderCell ? 'table_header_cell' : 'table_cell',
            list,
            table: createTableMetadata(tableNode, rowNode, cellNode),
        }
    }

    if (rowNode) {
        return {
            type: 'table_row',
            list,
        }
    }

    return {
        type: 'table',
        list,
    }
}
