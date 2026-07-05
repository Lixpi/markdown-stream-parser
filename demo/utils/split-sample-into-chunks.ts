import fs from 'fs'
import path from 'path'

import { log, info, warn, err } from './debug-tools.ts'

// Parse CLI arguments
const args = process.argv.slice(2);
let inputFilePath = '';
let chunkSize = 10; // Default chunk size
let outputPath = '';

for (const arg of args) {
    if (arg.startsWith('--file=')) {
        inputFilePath = arg.split('=')[1];
    }
    if (arg.startsWith('--chunkSize=')) {
        const val = parseInt(arg.split('=')[1], 10);
        if (!isNaN(val) && val > 0) chunkSize = val;
    }
    if (arg.startsWith('--outputPath=')) {
        outputPath = arg.split('=')[1];
    }
}

// Validate required arguments
if (!inputFilePath) {
    err('Missing required argument: --file=<path-to-input-file>');
    process.exit(1);
}

if (!outputPath) {
    err('Missing required argument: --outputPath=<relative-path-to-output-file>');
    process.exit(1);
}

// Check if input file exists
if (!fs.existsSync(inputFilePath)) {
    err(`Input file does not exist: ${inputFilePath}`);
    process.exit(1);
}

/**
 * Split text into chunks of specified size
 * @param text - The input text to split
 * @param chunkSize - The maximum size of each chunk
 * @returns Array of text chunks
 */
function splitTextIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let currentIndex = 0;

    while (currentIndex < text.length) {
        const chunk = text.slice(currentIndex, currentIndex + chunkSize);
        chunks.push(chunk);
        currentIndex += chunkSize;
    }

    return chunks;
}

/**
 * Create output directory if it doesn't exist
 * @param filePath - The full path to the output file
 */
function ensureDirectoryExists(filePath: string): void {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

;(async () => {
    try {
        info(`Reading input file: ${inputFilePath}`);

        // Read the input text file
        const inputText = fs.readFileSync(inputFilePath, { encoding: 'utf-8' });

        // Split text into chunks
        info(`Splitting text into chunks of size ${chunkSize}...`);
        const chunks = splitTextIntoChunks(inputText, chunkSize);

        // Resolve output path relative to the current working directory
        const absoluteOutputPath = path.resolve(outputPath);

        // Ensure output directory exists
        ensureDirectoryExists(absoluteOutputPath);

        // Write chunks to JSON file
        info(`Writing ${chunks.length} chunks to: ${absoluteOutputPath}`);
        fs.writeFileSync(absoluteOutputPath, JSON.stringify(chunks, null, 4), { encoding: 'utf-8' });

        log('✅ Successfully created chunked JSON file!');
        log('📊 Statistics:');
        log(`   - Original text length: ${inputText.length} characters`);
        log(`   - Number of chunks: ${chunks.length}`);
        log(`   - Chunk size: ${chunkSize} characters`);
        log(`   - Output file: ${absoluteOutputPath}`);

    } catch (error) {
        err('❌ Error processing file:', error);
        process.exit(1);
    }
})();
