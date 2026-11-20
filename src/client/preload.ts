import { isSlugPart } from "~/entities/slug";

import type { AssignmentLoader, AssignmentSnapshot, InitialAssignments } from "./session";

import { decodeAssignment } from "./loaders/shared";

export interface XpPreload {
  initialAssignments: InitialAssignments;
  initialErrors: readonly string[];
}
type Decision = Exclude<AssignmentSnapshot, { status: "loading" }>;

export function createXpRequest(load: AssignmentLoader, options: { signal?: AbortSignal } = {}) {
  const cache = new Map<string, Promise<Decision>>();
  const signal = options.signal ?? new AbortController().signal;

  async function loadDecision(slug: string): Promise<Decision> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const value = await Promise.race([
        cancelled.promise,
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return load(slug, { signal });
        }),
      ]);
      signal.throwIfAborted();
      return { status: "ready", slug: decodeAssignment(value, slug), error: null };
    } catch (cause) {
      signal.throwIfAborted();
      return {
        status: "error",
        slug: null,
        error: cause instanceof Error ? cause : new Error("Failed to resolve cohort", { cause }),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  function validate(slug: string) {
    if (!isSlugPart(slug)) throw new TypeError("Expected a kebab-case experiment slug");
  }

  function resolve(slug: string): Promise<Decision> {
    validate(slug);
    if (signal.aborted) return Promise.reject(signal.reason);
    let result = cache.get(slug);
    if (!result) {
      result = loadDecision(slug);
      cache.set(slug, result);
    }
    return result;
  }

  async function preload(slugs: readonly string[]): Promise<XpPreload> {
    signal.throwIfAborted();
    const names = [...new Set(slugs)];
    names.forEach(validate);
    const decisions = await Promise.all(
      names.map(async (name) => [name, await resolve(name)] as const),
    );
    const initialAssignments: Record<string, string | null> = {};
    const initialErrors: string[] = [];
    for (const [name, decision] of decisions) {
      if (decision.status === "ready") initialAssignments[name] = decision.slug;
      else initialErrors.push(name);
    }
    return { initialAssignments, initialErrors };
  }

  return { resolve, preload };
}
