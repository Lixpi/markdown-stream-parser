import type { Parser } from 'web-tree-sitter'
import { findActiveNodeAtPosition, findInlineNodeAtPosition } from './tree-navigation.js'

// Check if there's a complete code_span that overlaps with the given range.
export function hasCompleteCodeSpanAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
    const codeSpans = inlineRoot.descendantsOfType('code_span')
    for (const span of codeSpans) {
        // Check if this code_span overlaps with our range
        if (span.startIndex <= startPos && span.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap - if our content is inside a code_span
        if (span.startIndex < endPos && span.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if there's a complete strong_emphasis that overlaps with the given range.
export function hasCompleteBoldAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
    const strongNodes = inlineRoot.descendantsOfType('strong_emphasis')
    for (const span of strongNodes) {
        // Check if this strong_emphasis overlaps with our range
        if (span.startIndex <= startPos && span.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap - if our content is inside a strong_emphasis
        if (span.startIndex < endPos && span.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if there's a complete emphasis that overlaps with the given range.
export function hasCompleteItalicAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
    const emphasisNodes = inlineRoot.descendantsOfType('emphasis')
    for (const span of emphasisNodes) {
        // Check if this emphasis overlaps with our range
        if (span.startIndex <= startPos && span.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap - if our content is inside an emphasis
        if (span.startIndex < endPos && span.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if there's a complete strikethrough that overlaps with the given range.
export function hasCompleteStrikethroughAt(inlineRoot: Parser.SyntaxNode, startPos: number, endPos: number): boolean {
    const strikethroughNodes = inlineRoot.descendantsOfType('strikethrough')
    for (const span of strikethroughNodes) {
        // Check if this strikethrough overlaps with our range
        if (span.startIndex <= startPos && span.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap - if our content is inside a strikethrough
        if (span.startIndex < endPos && span.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if the text contains an unmatched italic marker (* or _)
// that is not part of a ** sequence.
// Uses tree-sitter to detect emphasis_delimiter nodes that aren't matched.
export function hasUnmatchedItalicMarker(text: string, inlineParser: Parser | null): boolean {
    // Use tree-sitter inline parser to check for emphasis markers
    if (inlineParser) {
        const inlineTree = inlineParser.parse(text)
        if (inlineTree) {
            // Get all emphasis (italic) and strong_emphasis (bold) nodes
            const emphasisNodes = inlineTree.rootNode.descendantsOfType('emphasis')
            const strongNodes = inlineTree.rootNode.descendantsOfType('strong_emphasis')

            // Helper to check if position is inside any matched emphasis or strong node
            const isInsideMatchedNode = (pos: number): boolean => {
                return emphasisNodes.some(node => pos >= node.startIndex && pos < node.endIndex) ||
                    strongNodes.some(node => pos >= node.startIndex && pos < node.endIndex)
            }

            const textContent = inlineTree.rootNode.text

            // Check for single * that isn't part of ** and isn't inside a matched node
            for (let i = 0; i < textContent.length; i++) {
                const char = textContent[i]
                if (char === '*') {
                    // Check if it's part of ** or ***
                    const prevChar = i > 0 ? textContent[i - 1] : ''
                    const nextChar = i < textContent.length - 1 ? textContent[i + 1] : ''

                    // If this * is adjacent to another *, it's part of ** or ***, skip it
                    if (prevChar === '*' || nextChar === '*') {
                        continue
                    }

                    // If this * is adjacent to /, it's part of /* or */ (comment delimiters), skip it
                    // These are NOT italic markers but likely code comment syntax
                    if (prevChar === '/' || nextChar === '/') {
                        continue
                    }

                    // This is a lone *, check if it's inside any emphasis or strong_emphasis node
                    if (!isInsideMatchedNode(i)) {
                        return true
                    }
                } else if (char === '_') {
                    // Underscore is a potential italic marker
                    // Check if it's inside a matched node
                    if (!isInsideMatchedNode(i)) {
                        return true
                    }
                }
            }

            return false
        }
    }

    // Fallback: simple character check without regex
    // Check for * that isn't part of **
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (char === '*') {
            const prevChar = i > 0 ? text[i - 1] : ''
            const nextChar = i < text.length - 1 ? text[i + 1] : ''
            // Skip if part of ** or adjacent to / (comment delimiters)
            if (prevChar !== '*' && nextChar !== '*' && prevChar !== '/' && nextChar !== '/') {
                return true // Lone asterisk found (not in **, /*, or */)
            }
        } else if (char === '_') {
            return true // Underscore found
        }
    }

    return false
}

// Check if the position is inside a fenced_code_block or code_span (inline code).
// Used to skip italic buffering inside code contexts where _ is common in variable names.
export function isInsideCodeBlock(
    node: Parser.SyntaxNode,
    position: number,
    currentTree: Parser.Tree | null,
    inlineParser: Parser | null
): boolean {
    let current: Parser.SyntaxNode | null = findActiveNodeAtPosition(node, position)

    while (current) {
        if (current.type === 'fenced_code_block' || current.type === 'code_fence_content') {
            return true
        }
        current = current.parent
    }

    // Also check inline tree for code_span (inline code like `variable_name`)
    if (currentTree && inlineParser) {
        const inlineNode = findInlineNodeAtPosition(currentTree.rootNode, position)
        if (inlineNode) {
            const inlineContent = inlineNode.text
            const inlineTree = inlineParser.parse(inlineContent)
            const relativePos = position - inlineNode.startIndex

            // Check if position is inside any code_span
            const codeSpans = inlineTree.rootNode.descendantsOfType('code_span')
            for (const span of codeSpans) {
                if (relativePos >= span.startIndex && relativePos < span.endIndex) {
                    return true
                }
            }
        }
    }

    return false
}

// Detect active inline styles at the given position range.
// Checks both the inline tree and block tree for style nodes.
export function detectActiveStyles(
    node: Parser.SyntaxNode,
    startIdx: number,
    endIdx: number,
    currentTree: Parser.Tree | null,
    inlineParser: Parser | null
): string[] {
    const styles: Set<string> = new Set()
    let current: Parser.SyntaxNode | null = node

    // First, find the inline node from the BLOCK tree (not the inline tree)
    // to get document-relative positions
    if (currentTree) {
        const blockInlineNode = findInlineNodeAtPosition(currentTree.rootNode, startIdx)
        if (blockInlineNode && inlineParser) {
            const inlineContent = blockInlineNode.text
            const inlineTree = inlineParser.parse(inlineContent)

            if (inlineTree) {
                // Calculate relative position within the inline content
                const relativeStart = startIdx - blockInlineNode.startIndex
                const relativeEnd = endIdx - blockInlineNode.startIndex

                // Check if our range overlaps with any inline style nodes
                const codeSpans = inlineTree.rootNode.descendantsOfType('code_span')
                for (const span of codeSpans) {
                    if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                        styles.add('code')
                        break
                    }
                }

                const emphases = inlineTree.rootNode.descendantsOfType('emphasis')
                for (const span of emphases) {
                    if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                        styles.add('italic')
                        break
                    }
                }

                const strongs = inlineTree.rootNode.descendantsOfType('strong_emphasis')
                for (const span of strongs) {
                    if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                        styles.add('bold')
                        break
                    }
                }

                const strikethroughs = inlineTree.rootNode.descendantsOfType('strikethrough')
                for (const span of strikethroughs) {
                    if (span.startIndex < relativeEnd && span.endIndex > relativeStart) {
                        styles.add('strikethrough')
                        break
                    }
                }
            }
        }
    }

    // Walk up the block tree for block-level styles
    while (current) {
        if (current.type === 'strong_emphasis' || current.type === 'strong') {
            styles.add('bold')
        } else if (current.type === 'emphasis' || current.type === 'em') {
            styles.add('italic')
        } else if (current.type === 'code_span') {
            styles.add('code')
        } else if (current.type === 'strikethrough') {
            styles.add('strikethrough')
        }
        // Skip inline node processing here - we already handled it above

        current = current.parent
    }

    return Array.from(styles)
}
