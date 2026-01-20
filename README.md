# @lixpi/markdown-stream-parser

A library designed to incrementally parse Markdown text from a stream of tokens.

It's built to handle the ambiguities of LLM-generated streams, which often produce imperfect or invalid Markdown.It uses **tree-sitter** under the hood. Instead of regex pattern matching, we get a proper AST that tells us exactly what's a header, what's a code block, what's bold text, etc. Tree-sitter's error recovery also handles the imperfect markdown that LLMs tend to produce.

### ⚠️ ***This project is still in active development - there are bugs and missing features.***

<br>

### DEMO: [markdown-stream-parser.lixpi.org](https://markdown-stream-parser.lixpi.org)

<br>

![sample](https://github.com/user-attachments/assets/6e3525f7-9082-46e9-853b-90ee20447fe5)


## Installation

NPM:
```bash
pnpm i @lixpi/markdown-stream-parser
npm i @lixpi/markdown-stream-parser
yarn add @lixpi/markdown-stream-parser
```

Or just clone the repository and import it directly from the source.

### Importing

The parser supports both ES6 module and CommonJS (Node.js) import styles.

**ES6 import:**
```typescript
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'
```

**CommonJS require:**
```typescript
const { MarkdownStreamParser } = require('@lixpi/markdown-stream-parser')
```

Can be used on a backend or frontend, there's no rendering logic involved.


### Basic Concepts

- **Singleton Pattern:**
  Use `MarkdownStreamParser.getInstance(instanceId)` to ensure one parser per logical stream/session.

- **Parsing Lifecycle:**
  - `startParsing()`: Begin parsing and set up subscriptions.
  - `parseToken(chunk: string)`: Feed incoming text chunks.
  - `stopParsing()`: Flush buffers, reset state, and notify listeners of stream end.

- **Subscribing to Output:**
  Use `subscribeToTokenParse(listener)` to receive parsed segments as soon as they are available. Returns an unsubscribe function.
  The unsubscribe function takes no arguments.


## How to Use

There are several ways to use the parser. It is quite modular. You can initialize it in one place and consume the parsed stream elsewhere, thanks to the singleton pattern.

## Subscribing to the Parser

Before you can parse the stream, you must subscribe to the parser. If you do not subscribe in advance, the parser will likely stop and terminate before you receive the first segment.

First import the parser and initialize it with an `instance-id`. (you can have as many parallel parsers as you want, just make sure to use different `instance-id`s)

```typescript
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'

// Get a parser instance (singleton per ID)
const parser = MarkdownStreamParser.getInstance('session-1')
```

#### Approach 1: The Simplest

```typescript
// Subscribe to parsed output
parser.subscribeToTokenParse((parsedSegment, unsubscribe) => {
    console.log(parsedSegment) // Happy little parsed segment

    // Clean up when the stream ends
    if (parsedSegment.status === 'END_STREAM') {
        unsubscribe()
        MarkdownStreamParser.removeInstance('session-1')
    }
})
```

#### Approach 2: Customizable

```typescript
// Subscribe to the parser service
const parserUnsubscribe = parser.subscribeToTokenParse(parsedSegment => {
    console.log(parsedSegment) // Happy little parsed segment
})

// When the stream has ended stop the parser to avoid issues and memory leaks.
// You can decide when to terminate the parser.
// For example, using your own logic or rely on the `parser.parsing` flag.
if (!parser.parsing) {
    parserUnsubscribe()    // Unsubscribe from the parser service
    MarkdownStreamParser.removeInstance('session-1')    // Dispose of the parser instance
}
```

## Parsing the Stream

Regardless of which subscription method you choose, feeding the stream into the parser does not change.
Once the subscription to the parser is initialized, you can start parsing the stream.

Again, this can be done in the same file or in a different part of your application. Just make sure to refer to the same parser `instance-id`.

```typescript
import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser'

// Get a parser instance (singleton per ID)
const parser = MarkdownStreamParser.getInstance('session-1')

// Start the parser
parser.startParsing()

// Your iterator function here
for await (const chunk of ["Hello", " ~~world~~", "!", "  \n"]) {
    parser.parseToken(chunk)
}

// Make sure to stop the parser at the end of the stream. It will flush any remaining content from the buffer.
parser.stopParsing()
```

The output is a series of objects containing the content of a parsed segment, the type of segment, and any possible inline styles.

```javascript
{
  status: 'STREAMING',
  segment: {
    segment: 'Hello ',
    styles: [],
    type: 'paragraph',
    isBlockDefining: true, // Indicates beginning of a new block, e.g. paragraph, heading, list etc...
    isProcessingNewLine: true
  }
}
{
  status: 'STREAMING',
  segment: {
    segment: 'world',
    styles: [ 'strikethrough' ],
    type: 'paragraph',
    isBlockDefining: false,
    isProcessingNewLine: false
  }
}
{
  status: 'STREAMING',
  segment: {
    segment: '!  ',
    styles: [],
    type: 'paragraph',
    isBlockDefining: false,
    isProcessingNewLine: false
  }
}
{ status: 'END_STREAM' }
```


## Is that it? What am I supposed to do with that?

Good question. You can use this stream to render styled content in your application in real time. Having a `segment type` and `inline styles` is enough to style it however you want.

It will **always remain `render-agnostic`** - whatever you use to render your styled text is entirely up to you.


## Features

- [x] Headers (`# H1`, `## H2`, etc.)
- [x] Paragraphs
- [x] Inline styles
  - [x] Inline Italic (`*text*`)
  - [x] Inline Bold (`**text**`)
  - [x] Inline Bold & Italic (`***text***`)
  - [x] Inline Strikethrough (`~~text~~`)
  - [x] Inline Code (`` `code` ``)
- [x] Code Blocks (```` ```code-block``` ````) with language detection
- [ ] Blockquotes (`> quote`) [Iusse #2](https://github.com/Lixpi/markdown-stream-parser/issues/2)
- [ ] //TODO: PRIORITY: Ordered Lists (`1. item`) [Iusse #3](https://github.com/Lixpi/markdown-stream-parser/issues/3)
- [ ] //TODO: PRIORITY: Unordered Lists (`- item`, `* item`, `+ item`) *BLOCKED BY:* [Iusse #3](https://github.com/Lixpi/markdown-stream-parser/issues/3)
- [ ] //TODO: Task Lists (`- [ ] item`) *BLOCKED BY:* [Iusse #3](https://github.com/Lixpi/markdown-stream-parser/issues/3)
- [ ] //TODO: PRIORITY: Tables [Iusse #7](https://github.com/Lixpi/markdown-stream-parser/issues/7)
- [ ] //TODO: PRIORITY: Links (`[text](url)`)
- [ ] //TODO: PRIORITY: Images (`![alt](url)`)
- [ ] //TODO: Horizontal Rules (`---`, `***`, `___`)
- [ ] //TODO: Footnotes
- [ ] //TODO: HTML blocks
- [ ] //TODO: Escaping (`\*literal asterisks\*`)
- [ ] //TODO: Automatic Links (`<http://example.com>`)
- [ ] //TODO: Emoji (`:smile:`)
- [ ] //TODO: Superscript (`x^2^`)
- [ ] //TODO: Subscript (`H~2~O`)


## Running examples

To try out the parser with example streams, look inside the `llm-streams-examples` directory. This folder contains real LLM responses collected from various providers. Each response has two versions:

- `*.json`: An array of items used for streaming
- `*.txt`: The same stream combined into a single file

Having the `*.txt` version is handy for visual comparison and debugging the parser.


Inside the repository root dir run:

1. Start the Docker container:
   ```bash
   docker compose up -d
   ```

2. Run the debug parser inside the container:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm run debug-parser --file=<file-path>
   ```

   Replace `<file-path>` with the relative path to any `.json` file. Examples:
   - For files in `llm-streams-examples`: `--file=demo/llm-streams-examples/claude-3.5-1-quantum-physics.json`
   - For manually created files: `--file=demo/llm-stream-examples-manually-simulated/long-consecutive-sequence.json`

3. **Creating custom test streams**: You can also create your own chunked streams from arbitrary text files using the `split-sample-into-chunks.ts` script:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm run split-sample-into-chunks -- --file=<input-file-path> --chunkSize=<chunk-size> --outputPath=<output-file-path>
   ```

   Example:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm run split-sample-into-chunks -- --file=demo/llm-input-examples-raw-text/long-consecutive-sequence.txt --chunkSize=2 --outputPath=demo/llm-stream-examples-manually-simulated/long-consecutive-sequence.json
   ```

This will execute the parser against the selected example stream and print parsed segments to the console.

## Running tests

The project includes comprehensive test coverage with 187 tests across all core functionality. To run the tests:

1. Start the Docker container:
   ```bash
   docker compose up -d
   ```

2. Run all tests:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm test:run
   ```

3. Run tests in watch mode during development:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm test
   ```

4. Run tests with coverage reporting:
   ```bash
   docker exec -it lixpi-markdown-stream-parser-demo pnpm test:coverage
   ```

**Note:** 3 tests are intentionally designed to fail to prove the existence of the known bug with long consecutive character sequences. All other tests should pass.

---


## How It Works

The parser uses **tree-sitter** for AST-based parsing. Instead of trying to match patterns with regex, we let tree-sitter build a syntax tree and then walk it to extract the content we need.

Here's the general flow:

```mermaid
flowchart LR
    A[Token] --> B[TokensStreamBuffer]
    B --> C[Accumulate Content]
    C --> D[Tree-sitter Parse]
    D --> E[AST Traversal]
    E --> F[Emit Segments]
```

#### 1. Token Buffering

Incoming tokens are accumulated in a `TokensStreamBuffer`. This gives us enough context to parse meaningful chunks rather than character-by-character.

#### 2. AST-Based Parsing with Tree-sitter

The core parsing is done by `web-tree-sitter` with the `tree-sitter-markdown` grammar. When content comes in, we parse it and get an AST that tells us exactly what we're dealing with - headers, paragraphs, code blocks, lists, bold text, whatever.

The nice thing about tree-sitter is that it handles incomplete/malformed markdown gracefully. It uses error recovery and can still produce a usable tree even when the input is partial or slightly broken (which happens constantly with LLM streams).

#### 3. Modular Architecture

The tree-sitter parsing logic is split into focused modules:

- **`block-detection.ts`** - Figures out what type of block we're in (header, paragraph, code block, list item, blockquote, table)
- **`inline-detection.ts`** - Detects active inline styles (bold, italic, code spans, strikethrough) by examining AST nodes
- **`content-extraction.ts`** - Strips markdown syntax (like `#` from headers or ``` from code blocks) and extracts clean content
- **`inline-extractors.ts`** - Specialized extractors for each inline style that properly strip markers and apply styles
- **`segment-generator.ts`** - Orchestrates everything and produces the final segments

Each module does one thing, which makes the code easier to reason about and test.

#### 4. Handling Incomplete Inline Markers

A tricky problem with streaming is that inline markers can arrive split across chunks. For example, you might get `**hello` in one chunk and `**` in the next.

The parser buffers content when it detects an unmatched delimiter. It uses tree-sitter to check whether a marker is complete:

```typescript
// Check for unmatched backtick
if (newPortion.includes('`')) {
    const hasCompleteCodeSpan = hasCompleteCodeSpanAt(inlineTree.rootNode, ...);
    if (!hasCompleteCodeSpan) {
        state.pendingInlineContent = newContent;
        return { segments, state };  // Buffer and wait for more
    }
}
```

This applies to inline code, bold (`**`), italic (`*` or `_`), and strikethrough (`~~`).

#### 5. Inline Parser for Detailed Analysis

For inline content within blocks, we use a second tree-sitter parser with the `tree-sitter-markdown-inline` grammar. This gives us detailed AST info about emphasis delimiters, code spans, etc.

The two-parser approach (one for block structure, one for inline content) is how tree-sitter-markdown is designed to work. It lets us accurately detect things like whether a `*` is actually an italic marker or just a literal asterisk.

#### 6. Publish/Subscribe Pattern

The parser uses a pub/sub pattern. You subscribe to get parsed segments as they're ready:

```mermaid
flowchart TD
    A[Input Tokens] -->|buffer| B(TokensStreamBuffer)
    B -->|raw content| C(Tree-sitter Parser)
    C -->|AST nodes| D(Segment Generator)
    D -->|notify| E[Subscribers]
```

Benefits:
- Real-time, event-driven processing
- Parsing is decoupled from rendering
- Multiple subscribers per parser instance

#### 7. Singleton Pattern

Each logical stream gets its own parser instance via `getInstance(instanceId)`. This allows parallel processing of multiple streams without state conflicts.

```typescript
const parser = await MarkdownStreamParser.getInstance('session-1')
// ... use the parser ...
MarkdownStreamParser.removeInstance('session-1')  // cleanup when done
```

---


## Known issues

- **Delayed processing for extremely long sequences of characters without whitespace**: Due to how token buffering works, extremely long uninterrupted sequences (like a huge regex) can delay output until the sequence completes. In practice this is rarely noticeable with modern LLM speeds, but it can happen.

---


## Contributions and Roadmap

- **Contributions:**
  PRs and issues are *welcome*! Feel free to share your thoughts in **[discussions](https://github.com/Lixpi/markdown-stream-parser/discussions)**.

- **Roadmap:**
  - Support for the missing markdown features listed earlier
  - Performance optimizations
  - Improved error recovery for malformed streams

---

## License

MIT
