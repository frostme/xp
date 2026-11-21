import { describe, expect, it, vi } from "vitest";

import type { AnalyticsDestination } from "~/entities/analytics";
import type {
  AnalyticsAdaptor,
  ClaimedDelivery,
  ClaimOptions,
  DeliveryResult,
} from "~/interfaces/analytics";

import { AnalyticsWorker } from "../worker";

const pending = (key: string, attempts = 1): ClaimedDelivery => ({
  provider: "custom:sink",
  destinationKey: key,
  subjectId: "external-" + key,
  attempts,
  leaseUntil: Date.now() + 30000,
  leaseToken: "lease",
  event: {
    id: "occurrence-" + key,
    occurredAt: "2026-11-01T00:00:00.000Z",
    name: "xp.cohort.joined",
    version: 1,
    experimentSlug: "checkout",
    cohortSlug: "checkout_off",
    source: "automatic",
  },
});

function storeFor(rows: ClaimedDelivery[]) {
  return {
    ready: vi.fn(async () => {}),
    claim: vi.fn(async (dest: AnalyticsDestination, options: ClaimOptions) => {
      const index = rows.findIndex(
        (item) => item.destinationKey === dest.key && item.provider === dest.provider,
      );
      return index < 0 ? [] : rows.splice(index, Math.min(1, options.limit));
    }),
    settle: vi.fn(async () => true),
    diagnostics: vi.fn(async () => ({
      counts: { pending: 1, claimed: 0, delivered: 0, failed: 0 },
      oldestPendingAt: 10,
    })),
  };
}
const adapt = (deliver: AnalyticsAdaptor["deliver"]): AnalyticsAdaptor => ({
  provider: "custom:sink",
  deliver,
});

describe("host-controlled delivery", () => {
  it("starts on demand, rotates bounded batches and isolates each adaptor's input", async () => {
    const db = storeFor([pending("broken"), pending("healthy"), pending("removed")]);
    const broken = vi.fn(async () => ({ status: "retry", reason: "private cause" }) as never);
    const healthy = vi.fn(async () => ({ status: "accepted" }) as const);
    const worker = new AnalyticsWorker(db as never, {
      adaptors: { broken: adapt(broken), healthy: adapt(healthy) },
      batchSize: 1,
    });
    expect(db.ready).not.toHaveBeenCalled();
    expect(await worker.drainOnce()).toEqual({
      claimed: 1,
      rescheduled: 1,
      delivered: 0,
      failed: 0,
      lost: 0,
    });
    expect(db.settle.mock.calls[0][1]).toMatchObject({ state: "pending", reason: "adaptor-error" });
    expect(await worker.drainOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(healthy).toHaveBeenCalledWith(
      { event: pending("healthy").event, subjectId: "external-healthy" },
      expect.any(AbortSignal),
      { attempt: 1 },
    );
    expect(await worker.drainOnce()).toMatchObject({ claimed: 0 });
    expect(db.claim.mock.calls.map(([dest]) => dest.key)).not.toContain("removed");
    expect(await worker.diagnostics("removed")).toMatchObject({ counts: { pending: 1 } });
    expect(db.ready).toHaveBeenCalledTimes(1);
    expect(worker.liveness).toMatchObject({ active: false, lastCompletedAt: expect.any(Number) });
  });
  it("bounds uncooperative requests and respects a lost lease", async () => {
    vi.useFakeTimers();
    try {
      const db = storeFor([pending("slow")]);
      db.settle.mockResolvedValue(false);
      const worker = new AnalyticsWorker(db as never, {
        adaptors: { slow: adapt(() => new Promise(() => {})) },
        requestTimeoutMs: 100,
      });
      const result = worker.drainOnce();
      await vi.advanceTimersByTimeAsync(120);
      expect(await result).toMatchObject({ claimed: 1, lost: 1, rescheduled: 0 });
      expect(db.settle.mock.calls[0][1]).toMatchObject({ state: "pending", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("leaves in-flight work recoverable on shutdown and exits even if the DB ignores cancellation", async () => {
    const db = storeFor([pending("active")]);
    const shutdown = new AbortController();
    const started = Promise.withResolvers<void>();
    const worker = new AnalyticsWorker(db as never, {
      adaptors: {
        active: adapt(() => {
          started.resolve();
          return new Promise(() => {});
        }),
      },
    });
    const running = worker.run({ signal: shutdown.signal });
    await started.promise;
    shutdown.abort();
    await running;
    expect(db.settle).not.toHaveBeenCalled();
    const blocked = Promise.withResolvers<ClaimedDelivery[]>();
    const claimed = Promise.withResolvers<void>();
    db.claim.mockImplementationOnce(() => {
      claimed.resolve();
      return blocked.promise;
    });
    const next = new AbortController();
    const draining = worker.run({ signal: next.signal });
    await claimed.promise;
    next.abort();
    await draining;
    blocked.resolve([pending("active")]);
    await Promise.resolve();
    expect(db.settle).not.toHaveBeenCalled();
  });
  it("parks claims exceeding the crash budget before calling the provider, and retries readiness failures", async () => {
    const db = storeFor([pending("sink", 4)]);
    db.ready.mockRejectedValueOnce(new Error("missing table"));
    const deliver = vi.fn(async (): Promise<DeliveryResult> => ({ status: "accepted" }));
    const worker = new AnalyticsWorker(db as never, {
      adaptors: { sink: adapt(deliver) },
      maxAttempts: 3,
    });
    await expect(worker.drainOnce()).rejects.toThrow("xp setup --analytics");
    expect(await worker.drainOnce()).toMatchObject({ failed: 1 });
    expect(deliver).not.toHaveBeenCalled();
  });
  it("validates time and concurrency bounds before opening storage", () => {
    const db = storeFor([]);
    for (const settings of [
      { batchSize: 0 },
      { parallelism: 33 },
      { leaseMs: 2000, requestTimeoutMs: 1900 },
      { maxAttempts: 101 },
      { pollMs: -1 },
    ]) {
      expect(() => new AnalyticsWorker(db as never, { adaptors: {}, ...settings })).toThrow();
    }
    expect(db.ready).not.toHaveBeenCalled();
  });
});
