<script lang="ts">
  import { cohortStore } from "@frostme/xp/svelte";
  let { slug }: { slug: string } = $props();
  const result = cohortStore(() => slug);
</script>
<output data-status={$result.status} data-xp-status>{$result.status}</output>
<output data-xp-slug>{$result.slug ?? ""}</output>
<output data-xp-error>{$result.error !== null}</output>
<button data-retry onclick={() => $result.refresh()}>Retry</button>
