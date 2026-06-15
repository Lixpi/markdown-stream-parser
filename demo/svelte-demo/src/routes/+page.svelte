<script lang="ts">
  import { onMount } from "svelte";
  import {
    MarkdownStreamParser,
    type StreamingChunk,
    type Chunk,
    type OpenSpan,
    type ClosedSpan,
    type SpanType,
  } from "../../../../src/tree-sitter-markdown-stream-parser.js";

  type ExampleFile = { base: string; json: string; txt: string };

  MarkdownStreamParser.configureWasmPath("/tree-sitter-markdown.wasm");

  let examples: ExampleFile[] = [];
  let selectedExample: ExampleFile | null = null;
  let delay = 80;
  let streaming = false;
  let paused = false;
  let tokens: string[] = [];
  let txtContent = "";
  let jsonContent = "";
  let parsedSegments: StreamingChunk[] = [];
  let parsedBlocks: Chunk[][] = [];
  let currentToken = "";
  let currentParsedChunks: StreamingChunk[] = [];
  let error = "";
  let jsonItems: string[] = [];
  let currentTokenIndex: number | null = null;
  let parserInitialized = false;
  let parser: MarkdownStreamParser | null = null;
  let parserId: string = "";

  // Track open spans across chunks for styling
  let openSpans: OpenSpan[] = [];

  async function loadExamples() {
    try {
      const res = await fetch("/llm-examples-manifest.json");
      examples = await res.json();
      selectedExample = examples[0] ?? null;
    } catch (e) {
      error = "Failed to load examples manifest.";
    }
  }

  async function loadSelectedFiles() {
    if (!selectedExample) return;
    try {
      const [jsonRes, txtRes] = await Promise.all([
        fetch(selectedExample.json),
        fetch(selectedExample.txt),
      ]);
      tokens = await jsonRes.json();
      txtContent = await txtRes.text();
      const rawJsonRes = await fetch(selectedExample.json);
      jsonContent = await rawJsonRes.text();
    } catch (e) {
      error = "Failed to load example files.";
    }
  }

  function handleExampleChange() {
    resetParser();
  }

  // Get active span types from open spans and chunk spans
  function getActiveSpanTypes(chunk: Chunk): SpanType[] {
    const types: SpanType[] = [];

    // Add types from contained spans (fully within this chunk)
    for (const span of chunk.contained) {
      if (!types.includes(span.type)) {
        types.push(span.type);
      }
    }

    // Add types from opening spans (start in this chunk)
    for (const span of chunk.opening) {
      if (!types.includes(span.type)) {
        types.push(span.type);
      }
    }

    // Add types from currently open spans (opened in previous chunks)
    for (const span of openSpans) {
      if (!types.includes(span.type)) {
        types.push(span.type);
      }
    }

    return types;
  }

  // Update open spans tracking based on chunk
  function updateOpenSpans(chunk: Chunk) {
    // Remove closed spans
    for (const closedSpan of chunk.closing) {
      openSpans = openSpans.filter((s) => s.type !== closedSpan.type);
    }

    // Add new opening spans
    for (const openSpan of chunk.opening) {
      openSpans = [...openSpans, openSpan];
    }
  }

  async function initializeParser() {
    parsedSegments = [];
    currentToken = "";
    currentParsedChunks = [];
    currentTokenIndex = null;
    error = "";
    openSpans = [];

    parserId = "demo-" + Date.now();

    try {
      parser = await MarkdownStreamParser.getInstance(parserId);
      parser.startParsing();

      parser.subscribeToTokenParse(
        (parsed: StreamingChunk, unsubscribe: () => void) => {
          if (parsed.status === "END_STREAM") {
            parsedSegments = [...parsedSegments, parsed];
            unsubscribe();
            MarkdownStreamParser.removeInstance(parserId);
            streaming = false;
            paused = false;
            currentTokenIndex = null;
            currentToken = "";
            parser = null;
            openSpans = [];
          } else if (parsed.status === "START_STREAM") {
            parsedSegments = [...parsedSegments, parsed];
          } else if (parsed.status === "STREAMING") {
            const chunk = parsed.chunk;

            console.log("📦 CHUNK received", {
              text: JSON.stringify(chunk.text),
              offset: chunk.offset,
              length: chunk.length,
              block: chunk.block.type,
              backtrackOffset: chunk.backtrackOffset,
            });

            if (chunk.backtrackOffset !== undefined) {
              console.warn("⚠️ BACKTRACK detected!", {
                backtrackOffset: chunk.backtrackOffset,
                chunkText: chunk.text,
                chunkOffset: chunk.offset,
                discarding: parsedSegments
                  .filter(
                    (seg) =>
                      seg.status === "STREAMING" &&
                      seg.chunk.offset + seg.chunk.length >
                        chunk.backtrackOffset!,
                  )
                  .map((seg) =>
                    seg.status === "STREAMING" ? seg.chunk.text : null,
                  ),
              });

              parsedSegments = parsedSegments.filter((seg) => {
                if (seg.status !== "STREAMING") return true;
                return (
                  seg.chunk.offset + seg.chunk.length <= chunk.backtrackOffset!
                );
              });

              openSpans = [];
            }

            parsedSegments = [...parsedSegments, parsed];
            updateOpenSpans(parsed.chunk);

            if (streaming || paused) {
              currentParsedChunks = [...currentParsedChunks, parsed];
            }
          }
        },
      );
    } catch (e) {
      console.error("Failed to initialize parser:", e);
      error = `Failed to initialize parser: ${e}`;
      streaming = false;
      parser = null;
    }
  }

  async function simulateStream() {
    if (!selectedExample) return;

    if (!parser || !streaming) {
      streaming = true;
      paused = false;
      await initializeParser();
    }

    if (!parser) {
      error = "Parser initialization failed";
      return;
    }

    for (
      let i = currentTokenIndex !== null ? currentTokenIndex + 1 : 0;
      i < tokens.length;
      i++
    ) {
      if (!streaming || paused) {
        if (paused) {
          currentTokenIndex = i - 1;
        } else {
          currentTokenIndex = null;
          currentToken = "";
          currentParsedChunks = [];
        }
        break;
      }

      currentParsedChunks = [];
      currentTokenIndex = i;
      currentToken = tokens[i];

      const parseError = parser.parseToken(tokens[i]);
      if (parseError) {
        console.error("Parse error:", parseError);
        error = `Parse error: ${parseError.message}`;
        break;
      }

      await new Promise((r) => setTimeout(r, delay));
    }

    if (streaming && !paused && currentTokenIndex === tokens.length - 1) {
      parser.stopParsing();
      streaming = false;
      currentTokenIndex = null;
      currentToken = "";
      currentParsedChunks = [];
      parser = null;
    }
  }

  function pauseStream() {
    if (streaming && !paused) {
      paused = true;
    }
  }

  function resumeStream() {
    if (paused) {
      paused = false;
      simulateStream();
    }
  }

  function processNextToken() {
    if (
      paused &&
      parser &&
      currentTokenIndex !== null &&
      currentTokenIndex < tokens.length - 1
    ) {
      const nextIndex = currentTokenIndex + 1;
      currentParsedChunks = [];
      currentTokenIndex = nextIndex;
      currentToken = tokens[nextIndex];

      const parseError = parser.parseToken(tokens[nextIndex]);
      if (parseError) {
        console.error("Parse error:", parseError);
        error = `Parse error: ${parseError.message}`;
        return;
      }

      if (nextIndex === tokens.length - 1) {
        parser.stopParsing();
        streaming = false;
        paused = false;
        parser = null;
      }
    }
  }

  function resetParser() {
    if (parser) {
      parser.stopParsing();
      MarkdownStreamParser.removeInstance(parserId);
      parser = null;
    }

    parsedSegments = [];
    parsedBlocks = [];
    currentToken = "";
    currentParsedChunks = [];
    currentTokenIndex = null;
    streaming = false;
    paused = false;
    error = "";
    openSpans = [];
  }

  // Group chunks into blocks based on block type changes
  $: parsedBlocks = (() => {
    const blocks: Chunk[][] = [];
    let currentBlock: Chunk[] = [];
    let lastBlockType: string | undefined = undefined;
    let lastBlockLevel: number | undefined = undefined;
    let lastOffset: number = -1;

    for (const seg of parsedSegments) {
      if (seg.status === "START_STREAM" || seg.status === "END_STREAM") {
        continue;
      }

      const chunk = seg.chunk;
      const blockType = chunk.block.type;
      const blockLevel = chunk.block.level;

      // Detect new block: type change, or heading level change
      // For list items, use gap in offset to detect new item
      let isNewBlock = false;

      if (blockType !== lastBlockType) {
        isNewBlock = true;
      } else if (blockType === "heading" && blockLevel !== lastBlockLevel) {
        isNewBlock = true;
      } else if (blockType === "list_item" && lastOffset >= 0) {
        // New list item if there's a significant gap in offset (indicates newline/new item)
        // Or if the text starts after a newline marker
        const gap = chunk.offset - lastOffset;
        if (gap > 50) {
          // Heuristic: large gap suggests new list item
          isNewBlock = true;
        }
      }

      if (isNewBlock && currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }

      currentBlock.push(chunk);
      lastBlockType = blockType;
      lastBlockLevel = blockLevel;
      lastOffset = chunk.offset + chunk.length;
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  })();

  onMount(async () => {
    console.log(
      "App mounted. Select 'test-error-recovery' and click 'Simulate stream' to see backtrack logs.",
    );
    try {
      const tempParser = await MarkdownStreamParser.getInstance("init");
      MarkdownStreamParser.removeInstance("init");
      parserInitialized = true;
    } catch (e) {
      console.error("Failed to initialize parser:", e);
      error = "Failed to load parser. Please check WASM file path.";
    }

    await loadExamples();
    await loadSelectedFiles();
  });

  $: if (selectedExample) {
    loadSelectedFiles();
  }

  $: {
    if (jsonContent) {
      try {
        const parsed = JSON.parse(jsonContent);
        if (Array.isArray(parsed)) {
          jsonItems = parsed;
        } else {
          console.error("Parsed jsonContent is not an array:", parsed);
          jsonItems = [];
        }
      } catch (e) {
        console.error("Failed to parse jsonContent:", e);
        jsonItems = [];
      }
    } else {
      jsonItems = [];
    }
  }

  // Helper function to determine CSS classes for text based on active spans
  function getSpanClasses(styles: SpanType[]): string {
    const classes: string[] = [];

    if (styles.includes("bold") && styles.includes("italic")) {
      classes.push("font-bold", "italic");
    } else if (styles.includes("bold")) {
      classes.push("font-bold");
    } else if (styles.includes("italic")) {
      classes.push("italic");
    }

    if (styles.includes("strikethrough")) {
      classes.push("line-through");
    }

    return classes.join(" ");
  }

  // Check if style includes code
  function hasCodeStyle(styles: SpanType[]): boolean {
    return styles.includes("code");
  }
</script>

<div class="p-6 min-h-screen bg-gray-50">
  <div class="mb-5">
    <h1 class="text-2xl font-bold mb-4">
      @lixpi/markdown-stream-parser <span class="text-gray-500"
        ><i>demo</i></span
      >
    </h1>
    <h2 class="mb-5">
      This is just a <b>quick and dirty showcase</b> of the
      <i>@lixpi/markdown-stream-parser</i>, the
      <b class="text-red-600">parser itself has nothing to do with rendering</b>
      !!! Please keep that in mind...
    </h2>
    <h3 class="mb-5">
      This <b>parser setup example is just an AI slop</b>, its only goal is to
      visually showcase the parser.
      <b
        >pls refer to the readme file for better instruction on how to user
        parser API</b
      >
    </h3>
  </div>
  <label class="block text-sm font-medium mb-1">Select LLM Example</label>
  <div class="mb-6 flex flex-col md:flex-row md:items-center gap-4">
    <select
      class="appearance-none rounded border bg-white px-3 py-1 pr-8 shadow leading-tight focus:outline-none focus:shadow-outline bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-right-1.5"
      bind:value={selectedExample}
      on:change={handleExampleChange}
    >
      {#each examples as ex}
        <option value={ex}>{ex.base}</option>
      {/each}
    </select>
    <div class="flex items-center gap-2">
      <label class="text-sm">Delay: {delay}ms</label>
      <input
        type="range"
        min="10"
        max="500"
        step="10"
        bind:value={delay}
        class="w-32"
      />
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        class="bg-blue-600 text-white px-3 py-1 rounded shadow hover:bg-blue-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
        on:click={simulateStream}
        disabled={streaming}
      >
        Simulate stream
      </button>
      {#if paused}
        <button
          class="bg-amber-500 text-white px-3 py-1 rounded shadow hover:bg-amber-600 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
          on:click={resumeStream}
        >
          Resume stream
        </button>
      {:else}
        <button
          class="bg-amber-500 text-white px-3 py-1 rounded shadow hover:bg-amber-600 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
          on:click={pauseStream}
          disabled={!streaming || paused}
        >
          Pause stream
        </button>
      {/if}
      <button
        class="bg-green-600 text-white px-3 py-1 rounded shadow hover:bg-green-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
        on:click={processNextToken}
        disabled={!paused ||
          currentTokenIndex === null ||
          currentTokenIndex >= tokens.length - 1}
      >
        Process next token
      </button>
      <button
        class="bg-red-600 text-white px-3 py-1 rounded shadow hover:bg-red-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
        on:click={resetParser}
        disabled={!parser && !parsedSegments.length}
      >
        Reset parser
      </button>
    </div>
    {#if error}
      <span class="text-red-600 ml-4 self-center">{error}</span>
    {/if}
  </div>

  <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
    <!-- Parsed stream column -->
    <div
      class="md:col-span-2 bg-white rounded shadow p-4 min-h-[400px] flex flex-col"
    >
      <h2 class="font-bold mb-2 text-lg">Parsed Stream</h2>
      <div class="flex-1 overflow-auto space-y-2">
        {#each parsedBlocks as block}
          {@const blockType = block[0]?.block.type}
          {@const blockLevel = block[0]?.block.level}
          {@const blockLanguage = block[0]?.block.language}
          {@const hasTableCells =
            blockType === "table_cell" || blockType === "table_row"}

          <div class="my-1 {hasTableCells ? 'flex flex-wrap gap-0' : ''}">
            {#if blockType === "heading"}
              {#if blockLevel === 1}
                <h1 class="inline text-2xl font-bold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h1>
              {:else if blockLevel === 2}
                <h2 class="inline text-xl font-bold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h2>
              {:else if blockLevel === 3}
                <h3 class="inline text-lg font-semibold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h3>
              {:else if blockLevel === 4}
                <h4 class="inline text-base font-semibold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h4>
              {:else if blockLevel === 5}
                <h5 class="inline text-sm font-semibold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h5>
              {:else if blockLevel === 6}
                <h6 class="inline text-xs font-semibold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </h6>
              {:else}
                <span class="inline font-semibold">
                  {#each block as chunk}
                    {@const styles = [
                      ...chunk.contained.map((s) => s.type),
                      ...chunk.opening.map((s) => s.type),
                    ]}
                    {#if hasCodeStyle(styles)}
                      <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                        >{chunk.text}</code
                      >
                    {:else}
                      <span class={getSpanClasses(styles)}>{chunk.text}</span>
                    {/if}
                  {/each}
                </span>
              {/if}
            {:else if blockType === "code_block"}
              <pre
                class="inline bg-gray-100 rounded p-1 font-mono text-sm text-gray-800 overflow-x-auto align-middle"><code
                  >{#each block as chunk}{chunk.text}{/each}</code
                ></pre>
              {#if blockLanguage}
                <span class="text-xs text-gray-500 ml-2">{blockLanguage}</span>
              {/if}
            {:else if blockType === "blockquote"}
              <span
                class="inline border-l-4 border-blue-400 pl-2 italic text-gray-700"
              >
                {#each block as chunk}
                  {@const styles = [
                    ...chunk.contained.map((s) => s.type),
                    ...chunk.opening.map((s) => s.type),
                  ]}
                  {#if hasCodeStyle(styles)}
                    <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                      >{chunk.text}</code
                    >
                  {:else}
                    <span class={getSpanClasses(styles)}>{chunk.text}</span>
                  {/if}
                {/each}
              </span>
            {:else if blockType === "list_item"}
              <span class="inline text-base leading-relaxed">
                <span class="mr-1">•</span>
                {#each block as chunk}
                  {@const styles = [
                    ...chunk.contained.map((s) => s.type),
                    ...chunk.opening.map((s) => s.type),
                  ]}
                  {#if hasCodeStyle(styles)}
                    <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                      >{chunk.text}</code
                    >
                  {:else}
                    <span class={getSpanClasses(styles)}>{chunk.text}</span>
                  {/if}
                {/each}
              </span>
            {:else if blockType === "table_cell" || blockType === "table_row"}
              {#each block as chunk}
                {@const styles = [
                  ...chunk.contained.map((s) => s.type),
                  ...chunk.opening.map((s) => s.type),
                ]}
                <span
                  class="inline-block border border-gray-300 px-2 py-1 text-sm"
                >
                  {#if hasCodeStyle(styles)}
                    <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                      >{chunk.text}</code
                    >
                  {:else}
                    <span class={getSpanClasses(styles)}>{chunk.text}</span>
                  {/if}
                </span>
              {/each}
            {:else}
              <!-- Default paragraph rendering -->
              <span class="inline text-base leading-relaxed">
                {#each block as chunk}
                  {@const styles = [
                    ...chunk.contained.map((s) => s.type),
                    ...chunk.opening.map((s) => s.type),
                  ]}
                  {#if hasCodeStyle(styles)}
                    <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                      >{chunk.text}</code
                    >
                  {:else}
                    <span class={getSpanClasses(styles)}>{chunk.text}</span>
                  {/if}
                {/each}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Current token & parsed chunk column -->
    <div class="flex flex-col gap-4 sticky top-6 self-start">
      <div class="bg-white rounded shadow p-4 min-h-[180px]">
        <h2 class="font-bold mb-2 text-lg">Current Token</h2>
        <pre
          class="font-mono text-blue-700 text-lg break-all whitespace-pre-wrap">{JSON.stringify(
            currentToken,
            null,
            2,
          )}</pre>
      </div>
      <div class="bg-white rounded shadow p-4 min-h-[180px] overflow-auto">
        <h2 class="font-bold mb-2 text-lg">Parsed Chunks</h2>
        {#if currentParsedChunks.length > 0}
          {#each currentParsedChunks as chunk, index}
            <div class="mb-2">
              <div class="text-xs font-semibold text-gray-500 mb-1">
                {index + 1} of {currentParsedChunks.length}
              </div>
              <pre
                class="font-mono text-gray-800 text-sm whitespace-pre-wrap">{JSON.stringify(
                  chunk,
                  null,
                  2,
                )}</pre>
            </div>
          {/each}
        {:else}
          <div class="text-gray-500 italic">
            No parsed chunks for this token
          </div>
        {/if}
      </div>
    </div>

    <!-- Raw JSON column -->
    <div class="bg-white rounded shadow p-4 min-h-[400px] flex flex-col">
      <h2 class="font-bold mb-2 text-lg">Raw array of streamed tokens</h2>
      <div
        class="flex-1 overflow-auto font-mono text-sm text-gray-700 space-y-1"
      >
        {#each jsonItems as item, index}
          <!-- Apply conditional background -->
          <div
            class="whitespace-pre-wrap break-all p-1 rounded transition-colors duration-150 {index ===
            currentTokenIndex
              ? 'bg-blue-200'
              : 'bg-gray-100 hover:bg-blue-100'}"
          >
            {JSON.stringify(item)}
          </div>
        {/each}
      </div>
    </div>

    <!-- Full txt column -->
    <div class="bg-white rounded shadow p-4 min-h-[400px] flex flex-col">
      <h2 class="font-bold mb-2 text-lg">Concatenated raw LLM output</h2>
      <pre
        class="flex-1 overflow-auto whitespace-pre-wrap text-gray-700">{txtContent}</pre>
    </div>
  </div>
</div>

<style>
  /* Tailwind is used, but you can add custom styles here if needed */
</style>
