<script lang="ts">
  import type { XpSessionOptions } from "@frostme/xp/client";
  import Panel from "../fixture-shared/svelte/Panel.svelte";
  import CheckoutBanner from "./xp/CheckoutBanner.svelte";
  let { xp, slug }: { xp: XpSessionOptions & { sessionKey?: string | number }; slug?: string } = $props();
</script>
<main>
  {#if !slug}<CheckoutBanner />{/if}
  <Panel {slug}/>
  <button data-xp-switch onclick={() => xp = { ...xp, sessionKey: String(xp.sessionKey) + "-" }}>Change account</button>
</main>
