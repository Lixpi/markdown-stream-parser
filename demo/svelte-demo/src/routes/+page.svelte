<script lang="ts">
  import { onMount } from "svelte";
  import {
    MarkdownStreamParser,
    type StreamingChunk,
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
  let parsedBlocks: StreamingChunk[][] = [];
  let currentToken = "";
  let currentParsedChunks: StreamingChunk[] = [];
  let error = "";
  let jsonItems: string[] = [];
  let currentTokenIndex: number | null = null;
  let parserInitialized = false;
  let parser: MarkdownStreamParser | null = null;
  let parserId: string = "";

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

  async function initializeParser() {
    parsedSegments = [];
    currentToken = "";
    currentParsedChunks = [];
    currentTokenIndex = null;
    error = "";

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
          } else if (parsed.status === "START_STREAM") {
            parsedSegments = [...parsedSegments, parsed];
          } else if (parsed.status === "STREAMING") {
            parsedSegments = [...parsedSegments, parsed];

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
  }

  $: parsedBlocks = (() => {
    const blocks: StreamingChunk[][] = [];
    let currentBlock: StreamingChunk[] = [];

    for (const seg of parsedSegments) {
      if (seg.status === "START_STREAM" || seg.status === "END_STREAM") {
        continue;
      }

      // Don't split blocks for table cells - keep them together in rows
      const isTableCell =
        seg.segment?.type === "table_cell" ||
        seg.segment?.type === "table_header_cell";
      const blockId = seg.segment?.blockId;

      const lastSeg =
        currentBlock.length > 0 ? currentBlock[currentBlock.length - 1] : null;
      const prevIsTableCell =
        lastSeg &&
        (lastSeg.segment?.type === "table_cell" ||
          lastSeg.segment?.type === "table_header_cell");
      const prevBlockId = lastSeg?.segment?.blockId;

      // Start a new block if isBlockDefining, but merge cells with same blockId
      if (seg.segment?.isBlockDefining && currentBlock.length) {
        let shouldSplit = true;

        // If both are table cells and have the same blockId, keep together
        if (
          isTableCell &&
          prevIsTableCell &&
          blockId !== undefined &&
          blockId === prevBlockId
        ) {
          shouldSplit = false;
        }

        if (shouldSplit) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
      }
      currentBlock.push(seg);
    }

    if (currentBlock.length) blocks.push(currentBlock);
    return blocks;
  })();

  onMount(async () => {
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
      This <b>demo is entirely `vibe-coded`</b>, while
      <b>the parser is painstakingly created by a human being 👩‍💻 :)</b>
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
          {@const hasTableCells = block.some(
            (seg) =>
              seg.segment?.type === "table_cell" ||
              seg.segment?.type === "table_header_cell",
          )}
          <div class="my-1 {hasTableCells ? 'flex flex-wrap gap-0' : ''}">
            {#each block as seg}
              {#if seg.segment?.type === "header"}
                {#if seg.segment?.level === 1}
                  <h1 class="inline text-2xl font-bold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h1>
                {:else if seg.segment?.level === 2}
                  <h2 class="inline text-xl font-bold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h2>
                {:else if seg.segment?.level === 3}
                  <h3 class="inline text-lg font-semibold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h3>
                {:else if seg.segment?.level === 4}
                  <h4 class="inline text-base font-semibold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h4>
                {:else if seg.segment?.level === 5}
                  <h5 class="inline text-sm font-semibold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h5>
                {:else if seg.segment?.level === 6}
                  <h6 class="inline text-xs font-semibold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </h6>
                {:else}
                  <span class="inline font-semibold">
                    {#if seg.segment?.styles?.length}
                      <span
                        class={seg.segment.styles.includes("bold") &&
                        seg.segment.styles.includes("italic")
                          ? "font-bold italic"
                          : seg.segment.styles.includes("bold")
                            ? "font-bold"
                            : seg.segment.styles.includes("italic")
                              ? "italic"
                              : ""}
                      >
                        {#if seg.segment.styles.includes("strikethrough")}
                          <span class="line-through"
                            >{seg.segment?.segment}</span
                          >
                        {:else if seg.segment.styles.includes("code")}
                          <code
                            class="bg-gray-200 rounded px-1 text-sm font-mono"
                            >{seg.segment?.segment}</code
                          >
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </span>
                {/if}
              {:else if seg.segment?.type === "codeBlock"}
                <pre
                  class="inline bg-gray-100 rounded p-1 font-mono text-sm text-gray-800 overflow-x-auto align-middle"><code
                    >{seg.segment?.segment}</code
                  ></pre>
              {:else if seg.segment?.type === "blockQuote"}
                <span
                  class="inline border-l-4 border-blue-400 pl-2 italic text-gray-700"
                  >{seg.segment?.segment}</span
                >
              {:else if seg.segment?.type === "list_item"}
                <span class="inline text-base leading-relaxed">
                  {#if seg.segment?.isBlockDefining}
                    <span class="mr-1">•</span>
                  {/if}
                  {#if seg.segment?.styles?.length}
                    <span
                      class={seg.segment.styles.includes("bold") &&
                      seg.segment.styles.includes("italic")
                        ? "font-bold italic"
                        : seg.segment.styles.includes("bold")
                          ? "font-bold"
                          : seg.segment.styles.includes("italic")
                            ? "italic"
                            : ""}
                    >
                      {#if seg.segment.styles.includes("strikethrough")}
                        <span class="line-through">{seg.segment?.segment}</span>
                      {:else if seg.segment.styles.includes("code")}
                        <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                          >{seg.segment?.segment}</code
                        >
                      {:else}
                        {seg.segment?.segment}
                      {/if}
                    </span>
                  {:else}
                    {seg.segment?.segment}
                  {/if}
                </span>
              {:else if seg.segment?.type === "table_header_cell"}
                <span
                  class="inline-block border border-gray-300 px-2 py-1 bg-gray-100 font-semibold text-sm"
                >
                  {#if seg.segment?.styles?.length}
                    <span
                      class={seg.segment.styles.includes("bold") &&
                      seg.segment.styles.includes("italic")
                        ? "font-bold italic"
                        : seg.segment.styles.includes("bold")
                          ? "font-bold"
                          : seg.segment.styles.includes("italic")
                            ? "italic"
                            : ""}
                    >
                      {#if seg.segment.styles.includes("strikethrough")}
                        <span class="line-through">{seg.segment?.segment}</span>
                      {:else if seg.segment.styles.includes("code")}
                        <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                          >{seg.segment?.segment}</code
                        >
                      {:else}
                        {seg.segment?.segment}
                      {/if}
                    </span>
                  {:else}
                    {seg.segment?.segment}
                  {/if}
                </span>
              {:else if seg.segment?.type === "table_cell"}
                <span
                  class="inline-block border border-gray-300 px-2 py-1 text-sm"
                >
                  {#if seg.segment?.styles?.length}
                    <span
                      class={seg.segment.styles.includes("bold") &&
                      seg.segment.styles.includes("italic")
                        ? "font-bold italic"
                        : seg.segment.styles.includes("bold")
                          ? "font-bold"
                          : seg.segment.styles.includes("italic")
                            ? "italic"
                            : ""}
                    >
                      {#if seg.segment.styles.includes("strikethrough")}
                        <span class="line-through">{seg.segment?.segment}</span>
                      {:else if seg.segment.styles.includes("code")}
                        <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                          >{seg.segment?.segment}</code
                        >
                      {:else}
                        {seg.segment?.segment}
                      {/if}
                    </span>
                  {:else}
                    {seg.segment?.segment}
                  {/if}
                </span>
              {:else}
                <span class="inline text-base leading-relaxed">
                  {#if seg.segment?.styles?.length}
                    <span
                      class={seg.segment.styles.includes("bold") &&
                      seg.segment.styles.includes("italic")
                        ? "font-bold italic"
                        : seg.segment.styles.includes("bold")
                          ? "font-bold"
                          : seg.segment.styles.includes("italic")
                            ? "italic"
                            : ""}
                    >
                      {#if seg.segment.styles.includes("strikethrough")}
                        <span class="line-through">{seg.segment?.segment}</span>
                      {:else if seg.segment.styles.includes("code")}
                        <code class="bg-gray-200 rounded px-1 text-sm font-mono"
                          >{seg.segment?.segment}</code
                        >
                      {:else}
                        {seg.segment?.segment}
                      {/if}
                    </span>
                  {:else}
                    {seg.segment?.segment}
                  {/if}
                </span>
              {/if}
            {/each}
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
