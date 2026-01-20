import type { Parser } from 'web-tree-sitter';
import { HEADER_MARKER_LEVELS, type BlockInfo, type BlockState } from './types.js';
import { findBlockNode } from './tree-navigation.js';

/**
 * Get the block type and properties from a tree-sitter node.
 * Walks up the tree to find the enclosing block structure.
 */
export function getBlockInfo(node: Parser.SyntaxNode): BlockInfo {
    let current: Parser.SyntaxNode | null = node;
    let foundParagraph = false;
    let foundTableCell = false;
    let isInHeader = false;

    while (current) {
        switch (current.type) {
            case 'atx_heading':
                return {
                    type: 'header',
                    level: getHeadingLevel(current)
                };
            case 'paragraph':
                // Don't return immediately - check if we're inside a list_item or blockquote
                foundParagraph = true;
                break;
            case 'fenced_code_block':
                return {
                    type: 'codeBlock',  // camelCase for consistency
                    language: getCodeBlockLanguage(current)
                };
            case 'list_item':
                // If we found a paragraph inside a list_item, return list_item
                return { type: 'list_item' };
            case 'blockquote':
                // If we found a paragraph inside a blockquote, return blockquote
                return { type: 'blockquote' };
            // Table types
            case 'pipe_table_cell':
                foundTableCell = true;
                break;
            case 'pipe_table_header':
                isInHeader = true;
                // If we found a cell inside a header, return table_header_cell
                if (foundTableCell) {
                    return { type: 'table_header_cell', id: current.id };
                }
                break;
            case 'pipe_table_row':
                // If we found a cell inside a regular row, return table_cell
                if (foundTableCell) {
                    return { type: 'table_cell', id: current.id };
                }
                break;
            case 'pipe_table':
                // Found the table - if we have a cell, determine type based on header flag
                if (foundTableCell) {
                    return { type: isInHeader ? 'table_header_cell' : 'table_cell', id: current.id };
                }
                // Otherwise just return table
                return { type: 'table' };
        }

        current = current.parent;
    }

    // If we found a paragraph but no enclosing list_item/blockquote, return paragraph
    if (foundParagraph) {
        return { type: 'paragraph' };
    }

    return { type: 'paragraph' };
}

/**
 * Check if the given node represents a new block compared to the current block state.
 */
export function isNewBlock(blockInfo: BlockInfo, node: Parser.SyntaxNode, currentBlock: BlockState | null): boolean {
    const blockNode = findBlockNode(node);
    if (!blockNode) return false;

    if (!currentBlock) return true;

    if (currentBlock.type !== blockInfo.type) return true;
    if (blockInfo.level !== undefined && currentBlock.level !== blockInfo.level) return true;

    if (blockNode.startIndex > currentBlock.lastSegmentEnd) return true;

    return false;
}

/**
 * Extract the heading level from an atx_heading node.
 * Uses tree-sitter node type lookup with fallback to character counting.
 */
export function getHeadingLevel(node: Parser.SyntaxNode): number {
    // Use tree-sitter node type lookup instead of regex
    for (const child of node.children) {
        const level = HEADER_MARKER_LEVELS[child.type];
        if (level !== undefined) {
            return level;
        }
    }

    // Fallback: count # characters if tree-sitter node not found
    const text = node.text || '';
    let hashCount = 0;
    for (let i = 0; i < text.length && text[i] === '#'; i++) {
        hashCount++;
    }
    if (hashCount >= 1 && hashCount <= 6 && (text[hashCount] === ' ' || text[hashCount] === undefined)) {
        return hashCount;
    }

    return 1;
}

/**
 * Extract the language identifier from a fenced_code_block node.
 */
export function getCodeBlockLanguage(node: Parser.SyntaxNode): string {
    // For fenced_code_block, look for info_string child
    if (node.type === 'fenced_code_block') {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && child.type === 'info_string') {
                return child.text.trim();
            }
        }
    }
    return '';
}
