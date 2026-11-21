import type {
  ClaimedDelivery,
  ClaimRef,
  DeliveryFailure,
  DeliveryResult,
  DeliveryTransition,
} from "~/interfaces/analytics";

const failureCodes: ReadonlySet<DeliveryFailure> = new Set([
  "network",
  "timeout",
  "rate-limited",
  "provider-unavailable",
  "unauthorized",
  "invalid-event",
  "invalid-response",
  "adaptor-error",
  "attempts-exhausted",
  "retry-after-limit",
]);

export function claimReference(claim: ClaimedDelivery): ClaimRef {
  return {
    eventId: claim.event.id,
    destinationKey: claim.destinationKey,
    leaseToken: claim.leaseToken,
  };
}

/** Reference predicate for the storage backends' conditional writes. */
export function ownsLease(claim: ClaimedDelivery, ref: ClaimRef, now: number): boolean {
  return (
    now < claim.leaseUntil &&
    claim.event.id === ref.eventId &&
    claim.destinationKey === ref.destinationKey &&
    claim.leaseToken === ref.leaseToken
  );
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = Object.freeze({
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 3_600_000,
});

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new RangeError("Analytics maxAttempts must be an integer from 1 to 100.");
  }
  if (
    !Number.isInteger(policy.initialDelayMs) ||
    !Number.isInteger(policy.maxDelayMs) ||
    policy.initialDelayMs < 1 ||
    policy.initialDelayMs > policy.maxDelayMs ||
    policy.maxDelayMs > 86_400_000
  ) {
    throw new RangeError(
      "Analytics retry delays must satisfy 1 <= initialDelayMs <= maxDelayMs <= 86400000.",
    );
  }
}

/** policy is checked at worker construction; attempts is one-based. */
export function nextDeliveryTransition(
  result: DeliveryResult,
  attempts: number,
  now: number,
  policy: RetryPolicy = defaultRetryPolicy,
  random: () => number = Math.random,
): DeliveryTransition {
  if (result.status === "accepted") return { state: "delivered" };

  const reason = failureCodes.has(result.reason) ? result.reason : "adaptor-error";
  if (result.status === "rejected") return { state: "failed", reason };
  if (attempts >= policy.maxAttempts) return { state: "failed", reason: "attempts-exhausted" };

  // Keep the server's lower bound, even if it exceeds the local backoff cap.
  // Park exceptionally long or unusable waits for an operator to re-drive.
  const retryAfterMs = result.retryAfterMs ?? 0;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs > 30 * 86_400_000) {
    return { state: "failed", reason: "retry-after-limit" };
  }
  const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempts - 1));
  const delay = Math.max(1, Math.ceil((ceiling * (1 + random())) / 2), Math.ceil(retryAfterMs));
  return { state: "pending", reason, availableAt: now + delay };
}
