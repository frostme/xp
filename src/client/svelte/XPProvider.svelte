<script lang="ts">
  import { onDestroy, setContext, untrack, type Snippet } from "svelte";
  import { createXpSession, type XpSession, type XpSessionOptions } from "../session.js";
  import { experimentKey, providerKey } from "./context.svelte.js";

  let {
    children, loader = "rest", endpoint, experimentHost, sessionKey, initialAssignments, initialErrors,
  }: XpSessionOptions & { children?: Snippet; sessionKey?: string | number } = $props();

  let previous: XpSession | undefined;
  const session = $derived.by(() => {
    // Include the account revision in the dependencies even when the transport is unchanged.
    void sessionKey;
    const transport = { loader, ...(endpoint !== undefined && { endpoint }), ...(experimentHost !== undefined && { experimentHost }) };
    const preload = previous ? {} : untrack(() => ({
      ...(initialAssignments !== undefined && { initialAssignments }),
      ...(initialErrors !== undefined && { initialErrors }),
    }));
    previous?.dispose();
    previous = createXpSession({ ...transport, ...preload });
    return previous;
  });
  // Capture the initial preload even if this provider begins with no decision consumers.
  untrack(() => session);
  setContext(providerKey, () => session);
  setContext(experimentKey, () => undefined);
  onDestroy(() => previous?.dispose());
</script>

{@render children?.()}
