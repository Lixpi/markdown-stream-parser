import type { Parser } from 'web-tree-sitter';

/**
 * Extract header content from a chunk, excluding marker nodes (# symbols).
 * Requires tree-sitter node for accurate extraction.
 */
export function getHeaderContent(
    content: string,
    node: Parser.SyntaxNode | undefined,
    startByte: number | undefined,
    endByte: number | undefined
): string {
    // If we have the tree-sitter node, extract the actual heading content for this chunk
    if (node && node.type === 'atx_heading' && startByte !== undefined && endByte !== undefined) {
        // Find which part of the current chunk overlaps with non-marker content
        let extractedText = '';

        for (const child of node.children) {
            // Skip marker nodes
            if (child.type.startsWith('atx_h') && child.type.endsWith('_marker')) {
                continue;
            }

            // Check if this child overlaps with our current chunk [startByte, endByte]
            if (child.startIndex < endByte && child.endIndex > startByte) {
                // Calculate the overlap
                const overlapStart = Math.max(child.startIndex, startByte);
                const overlapEnd = Math.min(child.endIndex, endByte);

                if (overlapStart < overlapEnd) {
                    // Extract just the overlapping portion
                    const relativeStart = overlapStart - startByte;
                    const relativeEnd = overlapEnd - startByte;
                    extractedText += content.substring(relativeStart, relativeEnd);
                }
            }
        }

        return extractedText;
    }

    throw new Error('Tree-sitter node required for header content extraction');
}

/**
 * Extract code block content from a chunk, excluding fence markers and info_string.
 * Requires tree-sitter node for accurate extraction.
 */
export function getCodeBlockContent(
    content: string,
    node: Parser.SyntaxNode | undefined,
    startByte: number | undefined,
    endByte: number | undefined
): string {
    // If we have the tree-sitter node, extract code content excluding fence markers
    if (node && node.type === 'fenced_code_block' && startByte !== undefined && endByte !== undefined) {
        let extractedText = '';

        for (const child of node.children) {
            // Skip fence markers and info_string
            if (child.type === 'fenced_code_block_delimiter' || child.type === 'info_string') {
                continue;
            }

            // Extract code content
            if (child.startIndex < endByte && child.endIndex > startByte) {
                const overlapStart = Math.max(child.startIndex, startByte);
                const overlapEnd = Math.min(child.endIndex, endByte);

                if (overlapStart < overlapEnd) {
                    const relativeStart = overlapStart - startByte;
                    const relativeEnd = overlapEnd - startByte;
                    extractedText += content.substring(relativeStart, relativeEnd);
                }
            }
        }

        return extractedText;
    }

    throw new Error('Tree-sitter node required for code block content extraction');
}
