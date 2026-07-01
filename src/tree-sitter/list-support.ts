import type { Node } from 'web-tree-sitter'
import type { ListMetadata } from './types.ts'

type Range = { start: number; end: number }

const LIST_MARKER_TYPES = [
    'list_marker_minus',
    'list_marker_plus',
    'list_marker_star',
    'list_marker_dot',
    'list_marker_parenthesis',
] as const

const TASK_MARKER_TYPES = [
    'task_list_marker_checked',
    'task_list_marker_unchecked',
] as const

function isListMarkerType(type: string): boolean {
    return LIST_MARKER_TYPES.indexOf(type as typeof LIST_MARKER_TYPES[number]) !== -1
}

function isTaskMarkerType(type: string): boolean {
    return TASK_MARKER_TYPES.indexOf(type as typeof TASK_MARKER_TYPES[number]) !== -1
}

function findEnclosingListItem(node: Node): Node | null {
    let current: Node | null = node

    while (current) {
        if (current.type === 'list_item') {
            return current
        }
        current = current.parent
    }

    return null
}

function getListDepth(node: Node): number {
    let listCount = 0
    let current: Node | null = node

    while (current) {
        if (current.type === 'list') {
            listCount++
        }
        current = current.parent
    }

    return Math.max(0, listCount - 1)
}

function getTaskMetadata(listItem: Node): ListMetadata['task'] | undefined {
    for (const child of listItem.children) {
        if (child.type === 'task_list_marker_checked') {
            return { checked: true }
        }
        if (child.type === 'task_list_marker_unchecked') {
            return { checked: false }
        }
    }

    return undefined
}

export function getListMetadata(node: Node): ListMetadata | undefined {
    const listItem = findEnclosingListItem(node)
    if (!listItem) {
        return undefined
    }

    const markerNode = listItem.children.find(child => isListMarkerType(child.type))
    if (!markerNode) {
        return undefined
    }

    const task = getTaskMetadata(listItem)
    const depth = getListDepth(listItem)

    let unorderedMarker: '-' | '+' | '*' | undefined
    switch (markerNode.type) {
        case 'list_marker_minus': unorderedMarker = '-'; break
        case 'list_marker_plus': unorderedMarker = '+'; break
        case 'list_marker_star': unorderedMarker = '*'; break
    }

    if (unorderedMarker) {
        const metadata: ListMetadata = { type: 'unordered', depth, marker: unorderedMarker }
        if (task) {
            metadata.task = task
        }
        return metadata
    }

    if (markerNode.type === 'list_marker_dot' || markerNode.type === 'list_marker_parenthesis') {
        const marker = markerNode.type === 'list_marker_dot' ? '.' : ')'
        const ordinalText = markerNode.text.trim().match(/^(\d+)/)?.[1]
        const ordinal = ordinalText ? Number(ordinalText) : undefined
        const metadata: ListMetadata = { type: 'ordered', depth, marker }

        if (ordinal !== undefined && Number.isSafeInteger(ordinal)) {
            metadata.ordinal = ordinal
        }
        if (task) {
            metadata.task = task
        }

        return metadata
    }

    return undefined
}

// A task marker can only ever appear as the first thing in a list item's
// content, immediately after the list marker node (which itself includes
// its trailing space). Scoping the pending-bracket check to this exact
// position avoids treating ordinary list text like "[ note] text" as a
// possible in-progress checkbox.
export function isAtListItemContentStart(node: Node, position: number): boolean {
    const listItem = findEnclosingListItem(node)
    if (!listItem) {
        return false
    }

    const markerNode = listItem.children.find(child => isListMarkerType(child.type))
    return markerNode !== undefined && position === markerNode.endIndex
}

export function isListScopedBlockContinuation(node: Node): boolean {
    if (node.type !== 'block_continuation') {
        return false
    }

    let current = node.parent
    while (current) {
        if (current.type === 'list_item') {
            return true
        }
        if (current.type === 'blockquote') {
            return false
        }
        current = current.parent
    }

    return false
}

function extendTaskMarkerRange(content: string, markerEnd: number): number {
    let end = markerEnd

    while (end < content.length && content[end] !== '\n' && /\s/.test(content[end])) {
        end++
    }

    return end
}

function collectSuppressedRanges(
    node: Node,
    content: string,
    startIndex: number,
    endIndex: number,
    ranges: Range[]
): void {
    if (node.endIndex <= startIndex || node.startIndex >= endIndex) {
        return
    }

    if (isTaskMarkerType(node.type)) {
        ranges.push({
            start: node.startIndex,
            end: extendTaskMarkerRange(content, node.endIndex),
        })
        return
    }

    if (isListScopedBlockContinuation(node)) {
        ranges.push({ start: node.startIndex, end: node.endIndex })
        return
    }

    for (const child of node.children) {
        collectSuppressedRanges(child, content, startIndex, endIndex, ranges)
    }
}

export function getListSuppressedRanges(
    root: Node,
    content: string,
    startIndex: number,
    endIndex: number
): Range[] {
    const ranges: Range[] = []
    collectSuppressedRanges(root, content, startIndex, endIndex, ranges)

    return ranges
        .map(range => ({
            start: Math.max(range.start, startIndex),
            end: Math.min(range.end, endIndex),
        }))
        .filter(range => range.start < range.end)
        .sort((a, b) => a.start - b.start)
}

export function stripListSuppressedRanges(
    text: string,
    root: Node,
    content: string,
    startIndex: number,
    endIndex: number
): string {
    const ranges = getListSuppressedRanges(root, content, startIndex, endIndex)
    if (ranges.length === 0) {
        return text
    }

    let result = ''
    let cursor = startIndex

    for (const range of ranges) {
        if (cursor < range.start) {
            result += content.substring(cursor, range.start)
        }
        cursor = Math.max(cursor, range.end)
    }

    if (cursor < endIndex) {
        result += content.substring(cursor, endIndex)
    }

    return result
}
