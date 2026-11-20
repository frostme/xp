import { isSlugPart } from "~/entities/slug";

import { decodeAssignment } from "../loaders/shared";

export type AssignmentLoader = (
  slug: string,
  options: { signal: AbortSignal },
) => Promise<string | null>;
export type InitialAssignments = Readonly<Record<string, string | null>>;

type Snapshot =
  | { status: "loading"; slug: null; error: null }
  | { status: "ready"; slug: string | null; error: null }
  | { status: "error"; slug: null; error: Error };

export type CohortResult = Snapshot & { refresh(): Promise<void> };

const pending: Snapshot = { status: "loading", slug: null, error: null };

/** One subscription and request lifecycle per experiment within a provider. */
class Assignment {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;
  private request:
    | { controller: AbortController; promise: Promise<void>; refreshing: boolean }
    | undefined;

  constructor(
    private readonly slug: string,
    private readonly loader: AssignmentLoader,
    private readonly initial: Snapshot = pending,
  ) {
    this.snapshot = initial;
  }

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.initial;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.snapshot.status === "loading" && !this.request) void this.load(false);
    return () => {
      this.listeners.delete(listener);
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

  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const notify of this.listeners) notify();
  }

  private load(refreshing: boolean): Promise<void> {
    const controller = new AbortController();
    const signal = controller.signal;
    const promise = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      let next: Snapshot;
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

export class Assignments {
  private readonly entries = new Map<string, Assignment>();

  constructor(
    private readonly loader: AssignmentLoader,
    initial?: InitialAssignments,
  ) {
    for (const [slug, value] of Object.entries(initial ?? {})) {
      if (!isSlugPart(slug)) throw new TypeError(`Invalid initial experiment slug: ${slug}`);
      this.entries.set(
        slug,
        new Assignment(slug, loader, {
          status: "ready",
          slug: decodeAssignment(value, slug),
          error: null,
        }),
      );
    }
  }

  entry(slug: string) {
    let entry = this.entries.get(slug);
    if (!entry) {
      entry = new Assignment(slug, this.loader);
      this.entries.set(slug, entry);
    }
    return entry;
  }
}
