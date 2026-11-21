import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AnalyticsAdaptor,
  AnalyticsStore,
  ClaimedDelivery,
  DeliveryResult,
  DeliverySummary,
} from "~/interfaces/analytics";

import {
  claimReference,
  defaultRetryPolicy,
  nextDeliveryTransition,
  ownsLease,
  validateRetryPolicy,
} from "../delivery";

const claim: ClaimedDelivery = {
  event: {
    name: "xp.cohort.joined",
    version: 1,
    id: "e330eb54-95bb-43b7-9986-7f36a32ad90f",
    occurredAt: "2026-10-26T17:00:00.000Z",
    cohortSlug: "checkout_banner",
    experimentSlug: "checkout",
    source: "automatic",
  },
  destinationKey: "reports",
  provider: "custom:reports",
  subjectId: "external-17",
  attempts: 1,
  leaseToken: "first-token",
  leaseUntil: 10_000,
};
const ref = claimReference(claim);
const policy = { maxAttempts: 10, initialDelayMs: 20, maxDelayMs: 100 };

describe("analytics claim ownership", () => {
  it("binds acknowledgments, reschedules, failures and renewal to one live lease", () => {
    expect(ownsLease(claim, ref, 9_999)).toBe(true);
    expect(ownsLease(claim, ref, 10_000)).toBe(false);
    expect(ownsLease(claim, { ...ref, eventId: "different" }, 9_999)).toBe(false);
    expect(ownsLease(claim, { ...ref, destinationKey: "other" }, 9_999)).toBe(false);
    expect(ownsLease(claim, { ...ref, leaseToken: "other" }, 9_999)).toBe(false);
  });

  it("fences the abandoned claimant after another worker takes ownership", () => {
    const takeover = { ...claim, attempts: 2, leaseToken: "second-token", leaseUntil: 20_000 };
    expect(ownsLease(takeover, ref, 10_001)).toBe(false);
    expect(ownsLease(takeover, claimReference(takeover), 10_001)).toBe(true);
  });

  it("keeps subject identity and claim credentials outside diagnostics and dispatch metadata", () => {
    expectTypeOf<keyof Parameters<AnalyticsAdaptor["deliver"]>[0]>().toEqualTypeOf<
      "event" | "subjectId"
    >();
    expectTypeOf<Awaited<ReturnType<AnalyticsStore["inspect"]>>>().toEqualTypeOf<
      DeliverySummary[]
    >();
    expectTypeOf<
      Extract<keyof DeliverySummary, "leaseToken" | "subjectId" | "event">
    >().toBeNever();
  });
});

describe("analytics delivery outcomes", () => {
  it("can accept an event on its last attempt", () => {
    expect(nextDeliveryTransition({ status: "accepted" }, 10, 0, policy)).toEqual({
      state: "delivered",
    });
  });

  it("parks permanent rejections and exhausted transient failures", () => {
    expect(
      nextDeliveryTransition({ status: "rejected", reason: "invalid-event" }, 1, 0, policy),
    ).toEqual({
      state: "failed",
      reason: "invalid-event",
    });
    expect(nextDeliveryTransition({ status: "retry", reason: "network" }, 10, 0, policy)).toEqual({
      state: "failed",
      reason: "attempts-exhausted",
    });
  });

  it("only persists allowlisted failure codes from third-party adaptors", () => {
    const unsafe = {
      status: "rejected",
      reason: "example-sensitive-body",
    } as unknown as DeliveryResult;
    expect(nextDeliveryTransition(unsafe, 1, 0)).toEqual({
      state: "failed",
      reason: "adaptor-error",
    });
  });

  it("applies capped exponential backoff with equal jitter", () => {
    const retry = { status: "retry", reason: "network" } as const;
    expect(nextDeliveryTransition(retry, 1, 100, policy, () => 0)).toEqual({
      state: "pending",
      availableAt: 110,
      reason: "network",
    });
    expect(nextDeliveryTransition(retry, 2, 100, policy, () => 0.5)).toEqual({
      state: "pending",
      availableAt: 130,
      reason: "network",
    });
    expect(nextDeliveryTransition(retry, 9, 100, policy, () => 0.99)).toEqual({
      state: "pending",
      availableAt: 200,
      reason: "network",
    });
  });

  it("honors Retry-After beyond local backoff, and parks unrepresentable waits", () => {
    const limited = { status: "retry", reason: "rate-limited" } as const;
    expect(
      nextDeliveryTransition({ ...limited, retryAfterMs: 65_000 }, 2, 100, policy, () => 0),
    ).toEqual({
      state: "pending",
      reason: "rate-limited",
      availableAt: 65_100,
    });
    for (const retryAfterMs of [Infinity, NaN, 31 * 86_400_000]) {
      expect(nextDeliveryTransition({ ...limited, retryAfterMs }, 1, 0)).toEqual({
        state: "failed",
        reason: "retry-after-limit",
      });
    }
  });

  it("checks finite retry settings before work begins", () => {
    expect(() => validateRetryPolicy(defaultRetryPolicy)).not.toThrow();
    for (const maxAttempts of [0, 101, 1.5, NaN, Infinity]) {
      expect(() => validateRetryPolicy({ ...policy, maxAttempts })).toThrow(RangeError);
    }
    for (const [initialDelayMs, maxDelayMs] of [
      [0, 100],
      [101, 100],
      [1, 86_400_001],
      [NaN, Infinity],
    ]) {
      expect(() =>
        validateRetryPolicy({
          ...policy,
          initialDelayMs: initialDelayMs!,
          maxDelayMs: maxDelayMs!,
        }),
      ).toThrow(RangeError);
    }
  });
});
