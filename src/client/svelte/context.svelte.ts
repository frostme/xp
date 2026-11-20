import { getContext, onMount } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import { toStore, type Readable } from "svelte/store";

import type { CohortResult, XpSession } from "../session.js";

export const providerKey = Symbol("xp provider");
export const experimentKey = Symbol("xp experiment");

export function enclosingExperiment(): () => string | undefined {
  return getContext<(() => string | undefined) | undefined>(experimentKey) ?? (() => undefined);
}

export function cohortStore(input?: string | (() => string)): Readable<CohortResult> {
  const getSession = getContext<(() => XpSession) | undefined>(providerKey);
  if (!getSession) throw new Error("cohortStore requires an XPProvider");
  const enclosing = enclosingExperiment();
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  const entry = $derived.by(() => {
    const session = getSession();
    const slug = typeof input === "function" ? input() : (input ?? enclosing());
    if (slug === undefined) throw new Error("Provide a slug or an enclosing Experiment");
    return {
      getSnapshot: () => session.getSnapshot(slug),
      track: createSubscriber((notify) => session.subscribe(slug, notify)),
      refresh: () => session.refresh(slug),
    };
  });

  return toStore(() => {
    if (mounted) entry.track();
    return { ...entry.getSnapshot(), refresh: entry.refresh };
  });
}
