<script lang="ts">
  import type { Snippet } from "svelte";
  import { parseGate, matchesGate } from "../gates.js";
  import { cohortStore, enclosingExperiment } from "./context.svelte.js";

  type Props = { children?: Snippet } & (
    | { default: true; slug?: never }
    | { default?: false; slug: string }
  );
  let { default: isDefault = false, slug, children }: Props = $props();
  const enclosing = enclosingExperiment();
  const gate = $derived(parseGate(enclosing(), slug, isDefault));
  const result = cohortStore(() => gate.experiment);
</script>

{#if matchesGate(gate, $result)}{@render children?.()}{/if}
