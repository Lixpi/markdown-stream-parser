<script lang="ts">
import { onMount } from 'svelte';
// import { MarkdownStreamParser } from '@lixpi/markdown-stream-parser';
import { MarkdownStreamParser } from '../../../../src/markdown-stream-parser.ts'

type ExampleFile = { base: string; json: string; txt: string };

let examples: ExampleFile[] = [];
let selectedExample: ExampleFile | null = null;
let delay = 80;
let streaming = false;
let paused = false;
let tokens: string[] = [];
let txtContent = '';
let jsonContent = '';
let parsedSegments: any[] = [];
let parsedBlocks: any[][] = [];
let currentToken = '';
let currentParsedChunks: any[] = []; // Array to hold all parsed chunks for the current token
let error = '';
let jsonItems: string[] = []; // Add state for parsed JSON items
let currentTokenIndex: number | null = null; // Track the index of the current token
let parser: any = null;
let parserId: string = '';

async function loadExamples() {
  try {
    const res = await fetch('/llm-examples-manifest.json');
    examples = await res.json();
    selectedExample = examples[0] ?? null;
  } catch (e) {
    error = 'Failed to load examples manifest.';
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
    // Fetch raw JSON as text for display
    const rawJsonRes = await fetch(selectedExample.json);
    jsonContent = await rawJsonRes.text();
  } catch (e) {
    error = 'Failed to load example files.';
  }
}

function handleExampleChange() {
  resetParser();
}

function initializeParser() {
  parsedSegments = [];
  currentToken = '';
  currentParsedChunks = [];
  currentTokenIndex = null; // Reset index before starting
  error = '';

  parserId = 'demo-' + Date.now();
  parser = MarkdownStreamParser.getInstance(parserId);
  parser.startParsing();

  // Add explicit types for parsed and unsubscribe
  parser.subscribeToTokenParse((parsed: any, unsubscribe: () => void) => {
    if (parsed.status === 'END_STREAM') {
      // Add parsed END_STREAM status to parsedSegments
      parsedSegments = [...parsedSegments, parsed];
      unsubscribe();
      MarkdownStreamParser.removeInstance(parserId);
      streaming = false;
      paused = false;
      currentTokenIndex = null; // Remove highlight when stream ends
      currentToken = ''; // Clear current token display
    } else {
      // Add new parsed segment to the list
      parsedSegments = [...parsedSegments, parsed];

      // For the current token, accumulate all parsed segments
      if (streaming || paused) {
        currentParsedChunks = [...currentParsedChunks, parsed];
      }
    }
  });
}

async function simulateStream() {
  if (!selectedExample) return;

  // Initialize parser if not already initialized
  if (!parser || !streaming) {
    streaming = true;
    paused = false;
    initializeParser();
  }

  for (let i = currentTokenIndex !== null ? currentTokenIndex + 1 : 0; i < tokens.length; i++) {
    if (!streaming || paused) {
      if (paused) {
        currentTokenIndex = i - 1; // Stay at current token when paused
      } else {
        currentTokenIndex = null; // Remove highlight if stopped
        currentToken = ''; // Clear current token if stopped
        currentParsedChunks = []; // Clear parsed chunks
      }
      break;
    }

    // Clear previous parsed chunks for this token
    currentParsedChunks = [];

    // Update current token display
    currentTokenIndex = i; // Highlight the current token index
    currentToken = tokens[i];

    // Process the token
    parser.parseToken(tokens[i]);

    // Wait for a moment to allow the parser to emit all segments for this token
    await new Promise((r) => setTimeout(r, delay));
  }

  // If we've reached the end of tokens and weren't paused or stopped
  if (streaming && !paused && currentTokenIndex === tokens.length - 1) {
    parser.stopParsing();
    streaming = false;
    currentTokenIndex = null;
    currentToken = '';
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
    simulateStream(); // Continue the stream from where it was paused
  }
}

function processNextToken() {
  if (paused && currentTokenIndex !== null && currentTokenIndex < tokens.length - 1) {
    const nextIndex = currentTokenIndex + 1;
    // Clear previous parsed chunks
    currentParsedChunks = [];

    currentTokenIndex = nextIndex;
    currentToken = tokens[nextIndex];
    parser.parseToken(tokens[nextIndex]);

    // If this was the last token, finish the stream
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
  currentToken = '';
  currentParsedChunks = [];
  currentTokenIndex = null;
  streaming = false;
  paused = false;
  error = '';
}

$: parsedBlocks = (() => {
  const blocks = [];
  let currentBlock = [];
  for (const seg of parsedSegments) {
    if (seg.segment?.isBlockDefining && currentBlock.length) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
    currentBlock.push(seg);
  }
  if (currentBlock.length) blocks.push(currentBlock);
  return blocks;
})();

onMount(async () => {
  await loadExamples();
  await loadSelectedFiles();
});

$: if (selectedExample) {
  loadSelectedFiles();
}

$: { // Reactive block to parse jsonContent when it changes
  if (jsonContent) {
    try {
      const parsed = JSON.parse(jsonContent);
      if (Array.isArray(parsed)) {
        jsonItems = parsed;
      } else {
        console.error("Parsed jsonContent is not an array:", parsed);
        jsonItems = []; // Reset or handle as appropriate
      }
    } catch (e) {
      console.error("Failed to parse jsonContent:", e);
      jsonItems = []; // Reset on error
    }
  } else {
    jsonItems = [];
  }
}
</script>

<div class="p-6 min-h-screen bg-gray-50">
    <div class="mb-5">
        <h1 class="text-2xl font-bold mb-4">@lixpi/markdown-stream-parser <span class="text-gray-500"><i>demo</i></span></h1>
        <h2 class="mb-5">This is just a <b>quick and dirty showcase</b> of the <i>@lixpi/markdown-stream-parser</i>, the <b class="text-red-600">parser itself has nothing to do with rendering</b> !!! Please keep that in mind...</h2>
        <h3 class="mb-5">This <b>demo is entirely `vibe-coded`</b>, while <b>the parser is painstakingly created by a human being 👩‍💻 :)</b></h3>
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
      <input type="range" min="10" max="500" step="10" bind:value={delay} class="w-32" />
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="bg-blue-600 text-white px-3 py-1 rounded shadow hover:bg-blue-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
              on:click={simulateStream}
              disabled={streaming}>
        Simulate stream
      </button>
      {#if paused}
        <button class="bg-amber-500 text-white px-3 py-1 rounded shadow hover:bg-amber-600 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
                on:click={resumeStream}>
          Resume stream
        </button>
      {:else}
        <button class="bg-amber-500 text-white px-3 py-1 rounded shadow hover:bg-amber-600 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
                on:click={pauseStream}
                disabled={!streaming || paused}>
          Pause stream
        </button>
      {/if}
      <button class="bg-green-600 text-white px-3 py-1 rounded shadow hover:bg-green-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
              on:click={processNextToken}
              disabled={!paused || currentTokenIndex === null || currentTokenIndex >= tokens.length - 1}>
        Process next token
      </button>
      <button class="bg-red-600 text-white px-3 py-1 rounded shadow hover:bg-red-700 disabled:bg-gray-400 disabled:hover:bg-gray-400 disabled:opacity-50"
              on:click={resetParser}
              disabled={!parser && !parsedSegments.length}>
        Reset parser
      </button>
    </div>
    {#if error}
      <span class="text-red-600 ml-4 self-center">{error}</span>
    {/if}
  </div>

  <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
    <!-- Parsed stream column -->
    <div class="md:col-span-2 bg-white rounded shadow p-4 min-h-[400px] flex flex-col">
      <h2 class="font-bold mb-2 text-lg">Parsed Stream</h2>
      <div class="flex-1 overflow-auto space-y-2">
        {#each parsedBlocks as block}
          <div class="my-1">
            {#each block as seg}
              {#if seg.segment?.type === 'header'}
                {#if seg.segment?.level === 1}
                  <h1 class="inline text-2xl font-bold">
                    {#if seg.segment?.styles?.length}
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
                      <span class={
                        seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                        seg.segment.styles.includes('bold') ? 'font-bold' :
                        seg.segment.styles.includes('italic') ? 'italic' :
                        ''
                      }>
                        {#if seg.segment.styles.includes('strikethrough')}
                          <span class="line-through">{seg.segment?.segment}</span>
                        {:else if seg.segment.styles.includes('code')}
                          <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
                        {:else}
                          {seg.segment?.segment}
                        {/if}
                      </span>
                    {:else}
                      {seg.segment?.segment}
                    {/if}
                  </span>
                {/if}
              {:else if seg.segment?.type === 'codeBlock'}
                <pre class="inline bg-gray-100 rounded p-1 font-mono text-sm text-gray-800 overflow-x-auto align-middle"><code>{seg.segment?.segment}</code></pre>
              {:else if seg.segment?.type === 'blockQuote'}
                <span class="inline border-l-4 border-blue-400 pl-2 italic text-gray-700">{seg.segment?.segment}</span>
              {:else}
                <span class="inline text-base leading-relaxed">
                  {#if seg.segment?.styles?.length}
                    <span class={
                      seg.segment.styles.includes('bold') && seg.segment.styles.includes('italic') ? 'font-bold italic' :
                      seg.segment.styles.includes('bold') ? 'font-bold' :
                      seg.segment.styles.includes('italic') ? 'italic' :
                      ''
                    }>
                      {#if seg.segment.styles.includes('strikethrough')}
                        <span class="line-through">{seg.segment?.segment}</span>
                      {:else if seg.segment.styles.includes('code')}
                        <code class="bg-gray-200 rounded px-1 text-sm font-mono">{seg.segment?.segment}</code>
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
        <pre class="font-mono text-blue-700 text-lg break-all whitespace-pre-wrap">{JSON.stringify(currentToken, null, 2)}</pre>
      </div>
      <div class="bg-white rounded shadow p-4 min-h-[180px] overflow-auto">
        <h2 class="font-bold mb-2 text-lg">Parsed Chunks</h2>
        {#if currentParsedChunks.length > 0}
          {#each currentParsedChunks as chunk, index}
            <div class="mb-2">
              <div class="text-xs font-semibold text-gray-500 mb-1">{index + 1} of {currentParsedChunks.length}</div>
              <pre class="font-mono text-gray-800 text-sm whitespace-pre-wrap">{JSON.stringify(chunk, null, 2)}</pre>
            </div>
          {/each}
        {:else}
          <div class="text-gray-500 italic">No parsed chunks for this token</div>
        {/if}
      </div>
    </div>

    <!-- Raw JSON column -->
    <div class="bg-white rounded shadow p-4 min-h-[400px] flex flex-col">
      <h2 class="font-bold mb-2 text-lg">Raw array of streamed tokens</h2>
      <div class="flex-1 overflow-auto font-mono text-sm text-gray-700 space-y-1">
        {#each jsonItems as item, index}
          <!-- Apply conditional background -->
          <div
            class="whitespace-pre-wrap break-all p-1 rounded transition-colors duration-150 {index === currentTokenIndex ? 'bg-blue-200' : 'bg-gray-100 hover:bg-blue-100'}"
          >
            {JSON.stringify(item)}
          </div>
        {/each}
      </div>
    </div>

    <!-- Full txt column -->
    <div class="bg-white rounded shadow p-4 min-h-[400px] flex flex-col">
      <h2 class="font-bold mb-2 text-lg">Concatenated raw LLM output</h2>
      <pre class="flex-1 overflow-auto whitespace-pre-wrap text-gray-700">{txtContent}</pre>
    </div>
  </div>
</div>

<style>
  /* Tailwind is used, but you can add custom styles here if needed */
</style>
