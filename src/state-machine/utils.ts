'use strict'

export const truncateTrailingNewLine = (input: string): string => {
    let end = input.length
    while (end > 0 && (input[end - 1] === '\n' || (end > 1 && input[end - 2] === '\\' && input[end - 1] === 'n'))) {
        if (input[end - 1] === '\n') {
            end--
        } else {
            end -= 2
        }
    }
    return input.substring(0, end)
}
