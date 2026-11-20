<script lang="ts">
  import { setContext, type Snippet } from "svelte";
  import { cohortStore, experimentKey } from "./context.svelte.js";

  let { slug, loading, children }: { slug: string; loading?: Snippet; children?: Snippet } = $props();
  const result = cohortStore(() => slug);
  setContext(experimentKey, () => slug);
</script>

{#if $result.status === "loading"}{@render loading?.()}{/if}
{@render children?.()}
