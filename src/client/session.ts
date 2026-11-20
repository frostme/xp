import { isSlugPart } from "~/entities/slug";

import type { XpPreload } from "./preload";

import { createGraphQLLoader } from "./loaders/graphql";
import { createRestLoader } from "./loaders/rest";
import { decodeAssignment, record } from "./loaders/shared";

export type AssignmentLoader = (
  slug: string,
  options: { signal: AbortSignal },
) => Promise<string | null>;
export type InitialAssignments = Readonly<Record<string, string | null>>;

export type AssignmentSnapshot =
  | { status: "loading"; slug: null; error: null }
  | { status: "ready"; slug: string | null; error: null }
  | { status: "error"; slug: null; error: Error };

export type CohortResult = AssignmentSnapshot & { refresh(): Promise<void> };

const pending: AssignmentSnapshot = { status: "loading", slug: null, error: null };

/** One subscription and request lifecycle per experiment within a provider. */
class Assignment {
  private listeners = new Set<() => void>();
  private snapshot: AssignmentSnapshot;
  private request:
    | { controller: AbortController; promise: Promise<void>; refreshing: boolean }
    | undefined;

  constructor(
    private readonly slug: string,
    private readonly loader: AssignmentLoader,
    private readonly initial: AssignmentSnapshot = pending,
  ) {
    this.snapshot = initial;
  }

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.initial;

  subscribe = (listener: () => void) => {
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.snapshot.status === "loading" && !this.request) void this.load(false);
    return () => {
      if (!this.listeners.delete(notify)) return;
      // React Strict Mode can immediately re-subscribe to the same entry.
      queueMicrotask(() => {
        if (this.listeners.size === 0) {
          this.request?.controller.abort();
          this.request = undefined;
        }
      });
    };
  };

  refresh = (): Promise<void> => {
    if (this.listeners.size === 0) return Promise.resolve();
    if (this.request?.refreshing) return this.request.promise;
    this.request?.controller.abort();
    return this.load(true);
  };

  dispose() {
    this.listeners.clear();
    this.request?.controller.abort();
    this.request = undefined;
  }

  private publish(snapshot: AssignmentSnapshot) {
    this.snapshot = snapshot;
    for (const notify of this.listeners) notify();
  }

  private load(refreshing: boolean): Promise<void> {
    const controller = new AbortController();
    const signal = controller.signal;
    const promise = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      let next: AssignmentSnapshot;
      try {
        const result = await this.loader(this.slug, { signal });
        next = { status: "ready", slug: decodeAssignment(result, this.slug), error: null };
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("Failed to resolve cohort", { cause });
        next = { status: "error", slug: null, error };
      }
      if (signal.aborted) return;
      this.request = undefined;
      this.publish(next);
    });
    this.request = { controller, promise, refreshing };
    if (this.snapshot !== pending) this.publish(pending);
    return promise;
  }
}

export type XpSessionOptions = Partial<XpPreload> & {
  loader?: "rest" | "graphql" | AssignmentLoader;
  experimentHost?: string;
  endpoint?: string;
};

export interface XpSession {
  getSnapshot(slug: string): AssignmentSnapshot;
  getServerSnapshot(slug: string): AssignmentSnapshot;
  subscribe(slug: string, notify: () => void): () => void;
  refresh(slug: string): Promise<void>;
  dispose(): void;
}

export function createXpSession(options: XpSessionOptions = {}): XpSession {
  const { loader, initialAssignments = {}, initialErrors = [] } = options;
  const resolve =
    typeof loader === "function"
      ? loader
      : loader === "graphql"
        ? createGraphQLLoader(options)
        : createRestLoader(options);
  const entries = new Map<string, Assignment>();
  let disposed = false;

  if (!record(initialAssignments) || !Array.isArray(initialErrors)) {
    throw new TypeError("Expected initialAssignments object and initialErrors array");
  }
  for (const [slug, value] of Object.entries(initialAssignments)) {
    if (!isSlugPart(slug)) throw new TypeError(`Invalid initial experiment slug: ${slug}`);
    entries.set(
      slug,
      new Assignment(slug, resolve, {
        status: "ready",
        slug: decodeAssignment(value, slug),
        error: null,
      }),
    );
  }
  for (const slug of initialErrors) {
    if (!isSlugPart(slug) || Object.hasOwn(initialAssignments, slug))
      throw new TypeError(`Invalid initial error entry: ${slug}`);
    entries.set(
      slug,
      new Assignment(slug, resolve, {
        status: "error",
        slug: null,
        error: new Error("Failed to resolve cohort"),
      }),
    );
  }

  function entry(slug: string) {
    if (disposed) throw new Error("This xp session has been disposed");
    if (!isSlugPart(slug)) throw new TypeError("Expected a kebab-case experiment slug");
    let found = entries.get(slug);
    if (!found) {
      found = new Assignment(slug, resolve);
      entries.set(slug, found);
    }
    return found;
  }

  return {
    getSnapshot: (slug) => entry(slug).getSnapshot(),
    getServerSnapshot: (slug) => entry(slug).getServerSnapshot(),
    subscribe: (slug, notify) => entry(slug).subscribe(notify),
    refresh: (slug) => entry(slug).refresh(),
    dispose() {
      disposed = true;
      for (const assignment of entries.values()) assignment.dispose();
      entries.clear();
    },
  };
}
