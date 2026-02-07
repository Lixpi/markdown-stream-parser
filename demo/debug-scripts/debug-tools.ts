'use strict'

import util from 'util'
import chalk from 'chalk'

let safeInspect = (val) => {
    try {
        return util.inspect(val, { showHidden: false, depth: null, colors: true })
    } catch (err) {
        return JSON.stringify(val, null, 2)
    }
}

// Iterating over the arguments and formatting them, if they are objects, using safeInspect, otherwise just returning them as they are
const formatArgs = (args) => args.map(arg => typeof arg === 'string' ? arg : safeInspect(arg))

export const log = (...args) => {
    if (typeof args[0] === 'string' && args.length > 1) {
        console.log(chalk.green(args[0]), ...formatArgs(args.slice(1)))
    } else {
        console.log(...formatArgs(args))
    }
}

export const info = (...args) => {
    if (typeof args[0] === 'string' && args.length > 1) {
        console.info(chalk.blue(args[0]), ...formatArgs(args.slice(1)))
    } else {
        console.info(...formatArgs(args))
    }
}

export const infoStr = (args: string[]) => {
    console.info(args.join(''))
}

export const warn = (...args) => {
    if (typeof args[0] === 'string' && args.length > 1) {
        console.warn(chalk.yellow(args[0]), ...formatArgs(args.slice(1)))
    } else {
        console.warn(...formatArgs(args))
    }
}

export const err = (...args) => {
    if (typeof args[0] === 'string' && args.length > 1) {
        console.error(chalk.red(args[0]), ...formatArgs(args.slice(1)))
    } else {
        console.error(...formatArgs(args))
    }
}
