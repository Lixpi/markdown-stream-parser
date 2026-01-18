/**
 * Debug script to trace why rendering stops at the nested code block
 */
import { MarkdownStreamParser } from '../../src/tree-sitter-markdown-stream-parser.js';
import * as fs from 'fs';

async function main() {
    const filePath = './demo/llm-streams-examples/x-BUG-gpt-4.5-nested-code-blocks.json';
    const tokens: string[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    console.log(`Total tokens: ${tokens.length}`);
    console.log(`Total content length: ${tokens.join('').length} bytes`);

    const parser = await MarkdownStreamParser.getInstance('debug-nested');

    let segmentCount = 0;
    let lastSegment = '';
    let lastTokenIndex = 0;
    let cumulativeContent = '';

    parser.subscribeToTokenParse((chunk, unsubscribe) => {
        if (chunk.status === 'START_STREAM') {
            console.log('[STREAM] Started');
        } else if (chunk.status === 'END_STREAM') {
            console.log('[STREAM] Ended');
            console.log(`Total segments emitted: ${segmentCount}`);
            console.log(`Last segment at token index: ${lastTokenIndex}`);
            console.log(`Last segment content: ${JSON.stringify(lastSegment)}`);
        } else if (chunk.status === 'STREAMING' && chunk.segment) {
            segmentCount++;
            lastSegment = chunk.segment.segment;
            lastTokenIndex = tokens.findIndex((t, i) =>
                cumulativeContent.length + tokens.slice(0, i + 1).join('').length > cumulativeContent.length
            );
        }
    });

    parser.startParsing();

    // Feed tokens one at a time
    for (let i = 0; i < tokens.length; i++) {
        cumulativeContent += tokens[i];

        const err = parser.parseToken(tokens[i]);
        if (err) {
            console.error(`[ERROR at token ${i}]: ${err.message}`);
            break;
        }

        // Log byte position periodically
        if (i % 50 === 0 || cumulativeContent.length > 870 && cumulativeContent.length < 900) {
            console.log(`Token ${i}: byte ${cumulativeContent.length}, content preview: ${JSON.stringify(tokens[i])}`);
        }
    }

    // Important: stop parsing to flush and trigger END_STREAM
    parser.stopParsing();
    MarkdownStreamParser.removeInstance('debug-nested');

    console.log('\n=== Content around byte 876 ===');
    console.log(cumulativeContent.substring(860, 920));
    console.log('=== End of debug ===');
}

main().catch(console.error);
