import type { Parser } from 'web-tree-sitter'
import { BLOCK_TYPES } from './types.js'

// Find the deepest node in the BLOCK tree that contains the given position.
// Uses exclusive end: position must be strictly less than endIndex.
// This ensures we find nodes that START at position, not ones that END at position.
export function findActiveNodeAtPosition(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
    if (position < node.startIndex || position >= node.endIndex) {
        return null
    }

    // Do not dive into inline nodes here.
    // We want to find the deepest node in the BLOCK tree (main tree).
    // Inline nodes (like bold, italic) will be handled by detectActiveStyles.
    // This ensures getBlockInfo always finds the correct block parent in the main tree.

    for (const child of node.children) {
        const childResult = findActiveNodeAtPosition(child, position)
        if (childResult) {
            return childResult
        }
    }

    return node
}

// Find a node in the tree that contains the given position.
// Uses inclusive end bounds.
export function findNodeInTree(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
    if (position < node.startIndex || position > node.endIndex) {
        return null
    }

    for (const child of node.children) {
        const result = findNodeInTree(child, position)
        if (result) {
            return result
        }
    }

    return node
}

// Find an inline node that contains the given position.
// Returns the 'inline' or 'pipe_table_cell' node if found.
export function findInlineNodeAtPosition(node: Parser.SyntaxNode, position: number): Parser.SyntaxNode | null {
    // If this node is an inline node that contains the position, return it
    if (node.type === 'inline' && position >= node.startIndex && position < node.endIndex) {
        return node
    }

    // Also check for pipe_table_cell - table cells contain inline content but without 'inline' wrapper
    if (node.type === 'pipe_table_cell' && position >= node.startIndex && position < node.endIndex) {
        return node
    }

    // Search children
    for (const child of node.children) {
        const result = findInlineNodeAtPosition(child, position)
        if (result) {
            return result
        }
    }

    return null
}

// Find the block-level node that contains the given node.
// Walks up the tree until a block type is found.
export function findBlockNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node

    while (current) {
        if (BLOCK_TYPES.indexOf(current.type as typeof BLOCK_TYPES[number]) !== -1) {
            return current
        }
        current = current.parent
    }

    return null
}
