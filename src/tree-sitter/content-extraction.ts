import type { Node, Tree } from 'web-tree-sitter'
import { stripListSuppressedRanges } from './list-support.ts'

// Extract header content from a chunk, excluding marker nodes (# symbols).
// Requires tree-sitter node for accurate extraction.
export function getHeaderContent(
    content: string,
    node: Node | undefined,
    startByte: number | undefined,
    endByte: number | undefined
): string {
    // If we have the tree-sitter node, extract the actual heading content for this chunk
    if (node && node.type === 'atx_heading' && startByte !== undefined && endByte !== undefined) {
        // Find which part of the current chunk overlaps with non-marker content
        let extractedText = ''

        for (const child of node.children) {
            // Skip marker nodes
            if (child.type.startsWith('atx_h') && child.type.endsWith('_marker')) {
                continue
            }

            // Check if this child overlaps with our current chunk [startByte, endByte]
            if (child.startIndex < endByte && child.endIndex > startByte) {
                // Calculate the overlap
                const overlapStart = Math.max(child.startIndex, startByte)
                const overlapEnd = Math.min(child.endIndex, endByte)

                if (overlapStart < overlapEnd) {
                    // Extract just the overlapping portion
                    const relativeStart = overlapStart - startByte
                    const relativeEnd = overlapEnd - startByte
                    extractedText += content.substring(relativeStart, relativeEnd)
                }
            }
        }

        return extractedText
    }

    throw new Error('Tree-sitter node required for header content extraction')
}

// Extract code block content from a chunk, excluding fence markers and info_string.
// Requires tree-sitter node for accurate extraction.
export function getCodeBlockContent(
    content: string,
    node: Node | undefined,
    startByte: number | undefined,
    endByte: number | undefined
): string {
    // If we have the tree-sitter node, extract code content excluding fence markers
    if (node && node.type === 'fenced_code_block' && startByte !== undefined && endByte !== undefined) {
        let extractedText = ''

        for (const child of node.children) {
            // Skip fence markers and info_string
            if (child.type === 'fenced_code_block_delimiter' || child.type === 'info_string') {
                continue
            }

            // Extract code content
            if (child.startIndex < endByte && child.endIndex > startByte) {
                const overlapStart = Math.max(child.startIndex, startByte)
                const overlapEnd = Math.min(child.endIndex, endByte)

                if (overlapStart < overlapEnd) {
                    const relativeStart = overlapStart - startByte
                    const relativeEnd = overlapEnd - startByte
                    const text = content.substring(relativeStart, relativeEnd)
                    extractedText += stripListSuppressedRanges(text, child, content, overlapStart, overlapEnd)
                }
            }
        }

        return extractedText
    }

    throw new Error('Tree-sitter node required for code block content extraction')
}

// Extract inline content from a chunk, stripping inline style markers.
// Uses the inline parser tree to identify and skip delimiter nodes.
export function getInlineContent(
    content: string,
    inlineTree: Tree,
    startOffset: number,
    endOffset: number
): string {
    const root = inlineTree.rootNode

    // Collect all delimiter positions to skip
    const skipRanges: Array<{ start: number; end: number }> = []

    // Find all inline style delimiters
    const delimiterTypes = [
        'emphasis_delimiter',      // * or _
        'code_span_delimiter',     // `
        'strikethrough'            // ~~
    ]

    // Collect emphasis delimiters
    const emphasisDelimiters = root.descendantsOfType('emphasis_delimiter')
    for (const delim of emphasisDelimiters) {
        skipRanges.push({ start: delim.startIndex, end: delim.endIndex })
    }

    // Collect code span delimiters
    const codeDelimiters = root.descendantsOfType('code_span_delimiter')
    for (const delim of codeDelimiters) {
        skipRanges.push({ start: delim.startIndex, end: delim.endIndex })
    }

    // Handle strikethrough - find ~~ markers
    const strikethroughNodes = root.descendantsOfType('strikethrough')
    for (const node of strikethroughNodes) {
        // First and last children are the ~~ delimiters
        if (node.childCount >= 2) {
            const firstChild = node.child(0)
            const lastChild = node.child(node.childCount - 1)
            if (firstChild && firstChild.text === '~~') {
                skipRanges.push({ start: firstChild.startIndex, end: firstChild.endIndex })
            }
            if (lastChild && lastChild.text === '~~') {
                skipRanges.push({ start: lastChild.startIndex, end: lastChild.endIndex })
            }
        }
    }

    // Handle strong_emphasis (bold) - the ** markers
    const strongNodes = root.descendantsOfType('strong_emphasis')
    for (const node of strongNodes) {
        // Walk children to find delimiter nodes
        for (const child of node.children) {
            if (child.type === 'emphasis_delimiter') {
                skipRanges.push({ start: child.startIndex, end: child.endIndex })
            }
        }
    }

    // Handle emphasis (italic) - the * or _ markers
    const emphasisNodes = root.descendantsOfType('emphasis')
    for (const node of emphasisNodes) {
        for (const child of node.children) {
            if (child.type === 'emphasis_delimiter') {
                skipRanges.push({ start: child.startIndex, end: child.endIndex })
            }
        }
    }

    // Sort ranges by start position
    skipRanges.sort((a, b) => a.start - b.start)

    // Build output by skipping delimiter ranges
    let result = ''
    let currentPos = 0

    for (const range of skipRanges) {
        // Only consider ranges that overlap with our content window
        if (range.end <= startOffset || range.start >= endOffset) {
            continue
        }

        // Add content before this range
        const rangeStartInContent = Math.max(range.start - startOffset, 0)
        if (rangeStartInContent > currentPos) {
            result += content.substring(currentPos, rangeStartInContent)
        }

        // Skip past this range
        currentPos = Math.max(currentPos, range.end - startOffset)
    }

    // Add remaining content
    if (currentPos < content.length) {
        result += content.substring(currentPos)
    }

    return result
}
