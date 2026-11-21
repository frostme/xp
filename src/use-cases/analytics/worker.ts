import { setTimeout as sleep } from "node:timers/promises";

import type { AnalyticsDestination } from "~/entities/analytics";
import type {
  AnalyticsAdaptor,
  AnalyticsStore,
  ClaimedDelivery,
  DeliveryResult,
  DeliveryState,
} from "~/interfaces/analytics";

import { validateDestination } from "./capture";
import {
  claimReference,
  defaultRetryPolicy,
  nextDeliveryTransition,
  validateRetryPolicy,
  type RetryPolicy,
} from "./delivery";
import { storageReadiness } from "./readiness";

export interface WorkerSettings {
  readonly adaptors: Readonly<Record<string, AnalyticsAdaptor>>;
  readonly batchSize?: number;
  readonly parallelism?: number;
  readonly requestTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}
export interface DrainCounts {
  claimed: number;
  delivered: number;
  rescheduled: number;
  failed: number;
  lost: number;
}
function bounded(name: string, value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function limit(value: number) {
  return bounded("limit", value, 1, 1000);
}
function timestamp(value: number) {
  return bounded("timestamp", value, 0, Number.MAX_SAFE_INTEGER);
}

// Leave an abandoned database claim recoverable when its driver or adaptor ignores cancellation.
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class AnalyticsWorker {
  private readonly routes: readonly AnalyticsDestination[];
  private readonly adaptors: ReadonlyMap<string, AnalyticsAdaptor>;
  private readonly ready: () => Promise<void>;
  private readonly batchSize: number;
  private readonly parallelism: number;
  private readonly requestTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly retry: RetryPolicy;
  private cursor = 0;
  private active = false;
  private startedAt: number | null = null;
  private completedAt: number | null = null;

  constructor(
    private readonly store: AnalyticsStore,
    options: WorkerSettings,
  ) {
    const entries = Object.entries(options.adaptors);
    if (entries.length > 32) throw new RangeError("Configure at most 32 analytics adaptors");
    this.routes = entries.map(([key, adaptor]) => {
      if (typeof adaptor?.deliver !== "function")
        throw new TypeError("An analytics adaptor requires deliver");
      return validateDestination({ key, provider: adaptor.provider });
    });
    this.adaptors = new Map(entries);
    this.ready = storageReadiness(store, this.routes);
    this.batchSize = bounded("batchSize", options.batchSize ?? 32, 1, 128);
    this.parallelism = bounded("parallelism", options.parallelism ?? 4, 1, 32);
    this.requestTimeoutMs = bounded(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? 5000,
      100,
      60000,
    );
    this.leaseMs = bounded(
      "leaseMs",
      options.leaseMs ?? 30000,
      Math.max(1000, this.requestTimeoutMs + 500),
      300000,
    );
    this.pollMs = bounded("pollMs", options.pollMs ?? 1000, 10, 60000);
    this.retry = {
      maxAttempts: options.maxAttempts ?? defaultRetryPolicy.maxAttempts,
      initialDelayMs: options.baseDelayMs ?? defaultRetryPolicy.initialDelayMs,
      maxDelayMs: options.maxDelayMs ?? defaultRetryPolicy.maxDelayMs,
    };
    validateRetryPolicy(this.retry);
  }

  get liveness() {
    return {
      active: this.active,
      lastStartedAt: this.startedAt,
      lastCompletedAt: this.completedAt,
    };
  }

  async drainOnce({
    signal = new AbortController().signal,
  }: { signal?: AbortSignal } = {}): Promise<DrainCounts> {
    if (this.active) throw new Error("This worker is already draining");
    signal.throwIfAborted();
    this.active = true;
    this.startedAt = Date.now();
    try {
      const counts = await untilAbort(this.drain(signal), signal);
      this.completedAt = Date.now();
      return counts;
    } finally {
      this.active = false;
    }
  }

  private async drain(signal: AbortSignal) {
    await this.ready();
    const counts: DrainCounts = { claimed: 0, delivered: 0, rescheduled: 0, failed: 0, lost: 0 };
    let empty = 0;
    while (!signal.aborted && empty < this.routes.length && counts.claimed < this.batchSize) {
      const capacity = Math.min(this.parallelism, this.batchSize - counts.claimed);
      const slots = Math.min(capacity, this.routes.length);
      const before = counts.claimed;
      const work = Array.from({ length: slots }, (_, index) => {
        const destination = this.routes[this.cursor]!;
        this.cursor = (this.cursor + 1) % this.routes.length;
        const quota = Math.floor(capacity / slots) + (index < capacity % slots ? 1 : 0);
        return this.deliverDue(destination, quota, counts, signal);
      });
      // A database failure in one lane must not detach its peers from the drain.
      const results = await Promise.allSettled(work);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      empty = before === counts.claimed ? empty + slots : 0;
    }
    return counts;
  }

  private async deliverDue(
    destination: AnalyticsDestination,
    quota: number,
    counts: DrainCounts,
    signal: AbortSignal,
  ) {
    const claims = await this.store.claim(destination, {
      now: Date.now(),
      limit: quota,
      leaseMs: this.leaseMs,
    });
    counts.claimed += claims.length;
    const results = await Promise.allSettled(
      claims.map(async (claim) => {
        if (signal.aborted) return;
        const result =
          claim.attempts > this.retry.maxAttempts
            ? ({ status: "rejected", reason: "attempts-exhausted" } as const)
            : await this.send(claim, signal);
        if (signal.aborted) return;
        const now = Date.now();
        const next = nextDeliveryTransition(result, claim.attempts, now, this.retry);
        const changed = await this.store.settle(claimReference(claim), next, now);
        counts[changed ? (next.state === "pending" ? "rescheduled" : next.state) : "lost"]++;
      }),
    );
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  private async send(claim: ClaimedDelivery, shutdown: AbortSignal): Promise<DeliveryResult> {
    const adaptor = this.adaptors.get(claim.destinationKey);
    if (adaptor?.provider !== claim.provider) throw new Error("Analytics claim binding mismatch");
    const remaining = claim.leaseUntil - Date.now() - 250;
    if (remaining <= 0) return { status: "retry", reason: "timeout" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, this.requestTimeoutMs));
    const signal = AbortSignal.any([shutdown, controller.signal]);
    try {
      const { event, subjectId } = claim;
      const result = await untilAbort(
        adaptor.deliver({ event, subjectId }, signal, { attempt: claim.attempts }),
        signal,
      );
      if (
        result?.status === "accepted" ||
        result?.status === "retry" ||
        result?.status === "rejected"
      )
        return result;
      return { status: "retry", reason: "adaptor-error" };
    } catch {
      return { status: "retry", reason: signal.aborted ? "timeout" : "adaptor-error" };
    } finally {
      clearTimeout(timer);
    }
  }

  async run({ signal }: { signal: AbortSignal }) {
    try {
      while (!signal.aborted) {
        const result = await this.drainOnce({ signal });
        if (!result.claimed) await sleep(this.pollMs, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async destinations(after: string | null = null, max = 50) {
    await this.ready();
    return this.store.destinations(after, limit(max));
  }
  async diagnostics(key: string) {
    await this.ready();
    const value = await this.store.diagnostics(key);
    return {
      ...value,
      oldestPendingAgeMs:
        value.oldestPendingAt === null ? null : Math.max(0, Date.now() - value.oldestPendingAt),
    };
  }
  async inspect(key: string, state: DeliveryState, max = 50) {
    await this.ready();
    return this.store.inspect(key, state, limit(max));
  }
  async redrive(key: string, eventId: string) {
    await this.ready();
    return this.store.redrive(key, eventId, Date.now());
  }
  async prune(key: string, before: number, max = 100) {
    await this.ready();
    return this.store.prune(key, timestamp(before), limit(max));
  }
  async purge(key: string, max = 100) {
    await this.ready();
    return this.store.purge(key, Date.now(), limit(max));
  }
}
