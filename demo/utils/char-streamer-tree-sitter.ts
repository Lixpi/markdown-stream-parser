import fs from 'fs'
import Parser from 'tree-sitter'
import Markdown from '@tree-sitter-grammars/tree-sitter-markdown';
import { MarkdownStreamParser, type StreamingChunk } from '../../src/tree-sitter-markdown-stream-parser.ts'

import { log, info, infoStr, warn, err } from './debug-tools.ts'

// Parse CLI arguments
const args = process.argv.slice(2);
let DELAY = 0;
let filePath = '';
let CHUNK_LIMIT: number | null = null;

for (const arg of args) {
    if (arg.startsWith('--interval=')) {
        const val = parseInt(arg.split('=')[1], 10);
        if (!isNaN(val)) DELAY = val;
    }
    if (arg.startsWith('--file=')) {
        filePath = arg.split('=')[1];
    }
    if (arg.startsWith('--limit=')) {
        const val = parseInt(arg.split('=')[1], 10);
        if (!isNaN(val)) CHUNK_LIMIT = val;
    }
}

if (!filePath) {
    throw new Error('Missing required argument: --file=<path-to-file>');
}

const sourceFile = `/usr/src/service/demo/llm-streams-examples/${filePath}`;

// Get parser instance with unique ID
const markdownStreamParser = MarkdownStreamParser.getInstance(filePath);

type JSONChunk = string | object;

async function* streamJSONinChunks(
    jsonArray: JSONChunk[], 
    limit?: number | null
): AsyncGenerator<JSONChunk, void, unknown> {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    const itemsToProcess = limit ? jsonArray.slice(0, limit) : jsonArray;
    
    for (const item of itemsToProcess) {
        if (item !== '') {
            yield item;
            await delay(DELAY);
        }
    }
}

(async () => {
    console.log('\n');
    console.log(`Loading file: ${sourceFile}`);
    console.log(`Delay between chunks: ${DELAY}ms`);
    if (CHUNK_LIMIT) {
        console.log(`Chunk limit: ${CHUNK_LIMIT}`);
    }
    console.log('\n');

    try {
        const jsonContent: string = fs.readFileSync(sourceFile, { encoding: 'utf-8' });
        const parsedJson: JSONChunk[] = JSON.parse(jsonContent);
        
        console.log(`Total chunks in file: ${parsedJson.length}`);
        console.log('Starting parser...\n');
        
        let chunkCounter = 0;
        
        // Subscribe to parsed segments
        const unsubscribe = markdownStreamParser.subscribeToTokenParse((chunk: StreamingChunk) => {
            if (chunk.status === 'START_STREAM') {
                console.log('=== Stream Started ===\n');
            } else if (chunk.status === 'END_STREAM') {
                console.log('\n=== Stream Ended ===');
            } else if (chunk.status === 'STREAMING' && chunk.segment) {
                console.log(`Segment:`, JSON.stringify(chunk, null, 2));
            }
        });
        
        // Start the parser
        markdownStreamParser.startParsing();
        
        // Process chunks using async generator
        for await (const chunk of streamJSONinChunks(parsedJson, CHUNK_LIMIT)) {
            chunkCounter++;
            
            const chunkStr = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
            console.log(`\nProcessing chunk ${chunkCounter}: "${chunkStr}"`);
            
            // Send chunk to parser
            const error = markdownStreamParser.parseToken(chunkStr);
            if (error) {
                console.error('Error parsing token:', error.message);
                break;
            }
        }
        
        // Stop the parser
        markdownStreamParser.stopParsing();
        
        // Display final summary
        console.log(`\nTotal chunks processed: ${chunkCounter}`);
        
        const summary = markdownStreamParser.getSegmentsSummary();
        console.log('\nSegments by type:', summary.byType);
        console.log('Total segments generated:', summary.total);
        console.log('Final content length:', markdownStreamParser.getCurrentContent().length, 'characters');
        
        // Cleanup
        unsubscribe();
        MarkdownStreamParser.removeInstance(filePath);
        
    } catch (error) {
        console.error('Error processing file:', error);
        process.exit(1);
    }
})();


// console.log('\n=== Final completed elements ===');
// accumulatedElements.forEach(elem => {
//     console.log(`- ${elem.type}${elem.level ? ` (h${elem.level})` : ''}: "${elem.text.substring(0, 50)}${elem.text.length > 50 ? '...' : ''}"`);
// });


// console.log("\n\n\n TREE", treeSitter);
// const callExpression = treeSitter.rootNode.child(1).firstChild;
// console.log(callExpression);

// Variables to maintain state
let content = '';
// let tree = null;
let subscribers = [];
let isParsingActive = false;

// Functions to mimic the original API
// const startParsing = () => {
//     isParsingActive = true;
//     content = '';
//     tree = null;
// };

// const parseToken = (chunk) => {
//     if (!isParsingActive) return;

//     const textChunk = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
//     content += textChunk;
    
//     // Parse the current content
//     tree = parser.parse(content, tree);
    
//     // Create a simplified representation of the parse tree
//     const parsedSegment = {
//         ast: simplifyNode(tree.rootNode),
//         content: content,
//         status: 'PARSING'
//     };
    
//     // Notify subscribers
//     notifySubscribers(parsedSegment);
// };

// const stopParsing = () => {
//     isParsingActive = false;
    
//     if (content && tree) {
//         // Final parse
//         tree = parser.parse(content, tree);
        
//         const finalSegment = {
//             ast: simplifyNode(tree.rootNode),
//             content: content,
//             status: 'END_STREAM'
//         };
        
//         notifySubscribers(finalSegment);
//     }
// };

// // Helper to simplify the tree-sitter node structure
// const simplifyNode = (node) => {
//     if (!node) return null;
    
//     const result = {
//         type: node.type,
//         text: node.text,
//         startPosition: node.startPosition,
//         endPosition: node.endPosition
//     };
    
//     if (node.childCount > 0) {
//         result.children = [];
//         for (let i = 0; i < node.childCount; i++) {
//             const child = node.child(i);
//             if (child) {
//                 result.children.push(simplifyNode(child));
//             }
//         }
//     }
    
//     return result;
// };

// // Subscription management
// const subscribeToTokenParse = (callback) => {
//     const subscriber = { callback };
//     subscribers.push(subscriber);
    
//     const unsubscribe = () => {
//         const index = subscribers.indexOf(subscriber);
//         if (index !== -1) {
//             subscribers.splice(index, 1);
//         }
//     };
    
//     return unsubscribe;
// };

// const notifySubscribers = (parsedSegment) => {
//     for (const subscriber of subscribers) {
//         const unsubscribe = () => {
//             const index = subscribers.indexOf(subscriber);
//             if (index !== -1) {
//                 subscribers.splice(index, 1);
//             }
//         };
        
//         subscriber.callback(parsedSegment, unsubscribe);
//     }
// };

// // Stream JSON chunks (unchanged from your original code)
// type JSONChunk = string | object;

// async function* streamJSONinChunks(jsonArray: JSONChunk[]): AsyncGenerator<JSONChunk, void, unknown> {
//     const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

//     for (const item of jsonArray) {
//         if (item !== '') {
//             yield item;
//             await delay(DELAY);
//         }
//     }
// }

// // Main execution
// (async () => {
//     console.log('\n');

//     const jsonContent: string = fs.readFileSync(sourceFile, { encoding: 'utf-8' });
//     const parsedJson: JSONChunk[] = JSON.parse(jsonContent);
//     const textStream = streamJSONinChunks(parsedJson);

//     startParsing();  // Start parsing before creating the stream

//     for await (const chunk of textStream) {
//         parseToken(chunk);
//     }

//     stopParsing();  // Flush any remaining content at the end
// })();

// // Subscribe to parse events
// const unsubscribe = subscribeToTokenParse(
//     (parsedSegment, unsubscribe) => {
//         console.log('parsedSegment', parsedSegment);

//         // Unsubscribe at the end of the stream
//         if (parsedSegment.status === 'END_STREAM') {
//             unsubscribe();
//             // No need to remove instance as we're not using the class approach
//         }
//     }
// );
