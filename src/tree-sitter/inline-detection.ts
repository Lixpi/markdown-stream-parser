import type { Parser, Tree, Node } from 'web-tree-sitter'
import { findActiveNodeAtPosition, findInlineNodeAtPosition } from './tree-navigation.ts'

// Check if there's a complete inline_link that overlaps with the given range.
export function hasCompleteLinkAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
    const linkNodes = inlineRoot.descendantsOfType('inline_link')
    for (const link of linkNodes) {
        // Check if this link overlaps with our range
        if (link.startIndex <= startPos && link.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap
        if (link.startIndex < endPos && link.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if there's a complete image that overlaps with the given range.
export function hasCompleteImageAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
    const imageNodes = inlineRoot.descendantsOfType('image')
    for (const img of imageNodes) {
        // Check if this image overlaps with our range
        if (img.startIndex <= startPos && img.endIndex >= endPos) {
            return true
        }
        // Also check partial overlap
        if (img.startIndex < endPos && img.endIndex > startPos) {
            return true
        }
    }
    return false
}

// Check if content has an incomplete link opening ([ without closing ])
export function hasIncompleteLinkOpening(text: string, inlineParser: Parser | null): boolean {
    if (!inlineParser) {
        return false
    }

    const inlineTree = inlineParser.parse(text)
    if (!inlineTree) {
        return false
    }

    // Tree-sitter parses incomplete link structures.
    // Look for link_text nodes that aren't part of a complete inline_link
    const linkTexts = inlineTree.rootNode.descendantsOfType('link_text')
    const completeLinks = inlineTree.rootNode.descendantsOfType('inline_link')
    const completeImages = inlineTree.rootNode.descendantsOfType('image')

    for (const linkText of linkTexts) {
        let isPartOfComplete = false

        // Check if this link_text is inside a complete link or image
        for (const link of completeLinks) {
            if (linkText.startIndex >= link.startIndex && linkText.endIndex <= link.endIndex) {
                isPartOfComplete = true
                break
            }
        }
        if (!isPartOfComplete) {
            for (const img of completeImages) {
                if (linkText.startIndex >= img.startIndex && linkText.endIndex <= img.endIndex) {
                    isPartOfComplete = true
                    break
                }
            }
        }

        if (!isPartOfComplete) {
            return true
        }
    }

    return false
}

// Check if content has an incomplete image opening (![ without closing ])
export function hasIncompleteImageOpening(text: string, inlineParser: Parser | null): boolean {
    if (!inlineParser) {
        return false
    }

    const inlineTree = inlineParser.parse(text)
    if (!inlineTree) {
        return false
    }

    // Tree-sitter parses incomplete image structures.
    // Look for image_description nodes that aren't part of a complete image
    const imageDescs = inlineTree.rootNode.descendantsOfType('image_description')
    const completeImages = inlineTree.rootNode.descendantsOfType('image')

    for (const desc of imageDescs) {
        let isPartOfComplete = false

        for (const img of completeImages) {
            if (desc.startIndex >= img.startIndex && desc.endIndex <= img.endIndex) {
                isPartOfComplete = true
                break
            }
        }

        if (!isPartOfComplete) {
            return true
        }
    }

    return false
}

// Check if there's a complete code_span that overlaps with the given range.
export function hasCompleteCodeSpanAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
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
export function hasCompleteBoldAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
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
export function hasCompleteItalicAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
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
export function hasCompleteStrikethroughAt(inlineRoot: Node, startPos: number, endPos: number): boolean {
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

// Check if the text contains an unmatched italic marker (* or _).
// Uses simple counting since tree-sitter doesn't parse unmatched markers as delimiters.
export function hasUnmatchedItalicMarker(text: string, inlineParser: Parser | null): boolean {
    // Count * and _ characters that could be emphasis markers
    // A marker is unmatched if there's an odd count of potential markers

    // Simple approach: check if there's an odd number of * or _ that could be markers
    // We need to be careful about:
    // 1. ** (bold) pairs vs * (italic) singles
    // 2. Escaped markers \* or \_
    // 3. Markers at word boundaries

    let singleAsterisks = 0
    let singleUnderscores = 0

    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        const prevChar = i > 0 ? text[i - 1] : ''
        const nextChar = i < text.length - 1 ? text[i + 1] : ''

        // Skip escaped characters
        if (prevChar === '\\') {
            continue
        }

        if (char === '*') {
            // Check if it's part of a ** sequence
            if (nextChar === '*') {
                // Start of ** - skip both
                i++
                continue
            }
            if (prevChar === '*') {
                // End of ** - already skipped the first one
                continue
            }
            // Single *
            singleAsterisks++
        }

        if (char === '_') {
            // Check if it's part of a __ sequence
            if (nextChar === '_') {
                i++
                continue
            }
            if (prevChar === '_') {
                continue
            }
            // Single _ - but only if at word boundary (not inside words like foo_bar)
            const isWordChar = (c: string) => c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
            const prevIsWord = prevChar && isWordChar(prevChar)
            const nextIsWord = nextChar && isWordChar(nextChar)
            // _ in the middle of a word is not an emphasis marker
            if (prevIsWord && nextIsWord) {
                continue
            }
            singleUnderscores++
        }
    }

    // If odd number of potential markers, we have unmatched markers
    return (singleAsterisks % 2 !== 0) || (singleUnderscores % 2 !== 0)
}

// Check if the position is inside a fenced_code_block or code_span (inline code).
// Used to skip italic buffering inside code contexts where _ is common in variable names.
export function isInsideCodeBlock(
    node: Node,
    position: number,
    currentTree: Tree | null,
    inlineParser: Parser | null
): boolean {
    let current: Node | null = findActiveNodeAtPosition(node, position)

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
    node: Node,
    startIdx: number,
    endIdx: number,
    currentTree: Tree | null,
    inlineParser: Parser | null
): string[] {
    const styles: Set<string> = new Set()
    let current: Node | null = node

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
