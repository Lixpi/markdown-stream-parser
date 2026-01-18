import fs from 'fs'

// import { log, info, infoStr, warn, err } from './debug-tools.ts'

import { MarkdownStreamParser } from '../../src/markdown-stream-parser.ts'

// Parse CLI arguments
const args = process.argv.slice(2);
let DELAY = 0;
let filePath = '';

for (const arg of args) {
    if (arg.startsWith('--interval=')) {
        const val = parseInt(arg.split('=')[1], 10);
        if (!isNaN(val)) DELAY = val;
    }
    if (arg.startsWith('--file=')) {
        filePath = arg.split('=')[1];
    }
}

if (!filePath) {
    throw new Error('Missing required argument: --file=<path-to-file>');
}

const sourceFile = `/usr/src/service/${filePath}`;

const markdownStreamParser = MarkdownStreamParser.getInstance(filePath)

type JSONChunk = string | object; // Adjust as needed for your JSON structure

async function* streamJSONinChunks(jsonArray: JSONChunk[]): AsyncGenerator<JSONChunk, void, unknown> {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Iterate over each object in the json array
    for (const item of jsonArray) {
        if (item !== '') {
            yield item;
            await delay(DELAY);
        }
    }
}


;(async () => {
    console.log('\n')

    const jsonContent: string = fs.readFileSync(sourceFile, { encoding: 'utf-8' });
    const parsedJson: JSONChunk[] = JSON.parse(jsonContent);
    const textStream = streamJSONinChunks(parsedJson);

    markdownStreamParser.startParsing()    // Parser has to be started before the stream is created

    for await (const chunk of textStream) {
        markdownStreamParser.parseToken(chunk);
    }

    markdownStreamParser.stopParsing()    // At the end of the stream, it flushes any remaining content

})()


type UnsubscribeFn = () => void;

markdownStreamParser.subscribeToTokenParse(
    (parsedSegment: any, unsubscribe: UnsubscribeFn) => {
        console.log('parsedSegment', parsedSegment)    // Happy little parsed segment

        // At the end of the stream, unsubscribe from the parser service
        if (parsedSegment.status === 'END_STREAM') {
            unsubscribe()
            MarkdownStreamParser.removeInstance(filePath)
        }
    }
)
