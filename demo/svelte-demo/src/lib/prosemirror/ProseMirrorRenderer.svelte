<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { StreamingChunk } from "../../../../../src/markdown-stream-parser.ts";
  import {
    createStreamRenderer,
    type StreamRenderer,
  } from "./editor.ts";

  let mountEl: HTMLDivElement;
  let renderer: StreamRenderer | null = null;

  export function handleStreamingChunk(parsed: StreamingChunk): void {
    renderer?.handleStreamingChunk(parsed);
  }

  export function reset(): void {
    renderer?.reset();
  }

  onMount(() => {
    renderer = createStreamRenderer(mountEl);
  });

  onDestroy(() => {
    renderer?.destroy();
    renderer = null;
  });
</script>

<div bind:this={mountEl} class="prose prose-sm max-w-none"></div>
