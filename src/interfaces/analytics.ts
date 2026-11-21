import type { AnalyticsDestination, PendingDelivery } from "~/entities/analytics";

export type DeliveryState = "pending" | "claimed" | "delivered" | "failed";

/** Only these codes can enter the outbox or worker diagnostics. */
export type DeliveryFailure =
  | "network"
  | "timeout"
  | "rate-limited"
  | "provider-unavailable"
  | "unauthorized"
  | "invalid-event"
  | "invalid-response"
  | "adaptor-error"
  | "attempts-exhausted"
  | "retry-after-limit";

export type DeliveryResult =
  | { readonly status: "accepted" }
  | { readonly status: "retry"; readonly reason: DeliveryFailure; readonly retryAfterMs?: number }
  | { readonly status: "rejected"; readonly reason: DeliveryFailure };

export interface AnalyticsAdaptor {
  readonly provider: string;
  deliver(
    delivery: Pick<PendingDelivery, "event" | "subjectId">,
    signal: AbortSignal,
    context: { readonly attempt: number },
  ): Promise<DeliveryResult>;
}

export interface ClaimRef {
  readonly eventId: string;
  readonly destinationKey: string;
  readonly leaseToken: string;
}

/** attempts counts claims, including attempts interrupted before acknowledgment. */
export interface ClaimedDelivery extends PendingDelivery {
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseUntil: number;
}

export type DeliveryTransition =
  | { readonly state: "delivered" }
  | { readonly state: "pending"; readonly availableAt: number; readonly reason: DeliveryFailure }
  | { readonly state: "failed"; readonly reason: DeliveryFailure };

/** Public inspection deliberately omits the subject, payload and lease token. */
export interface DeliverySummary {
  readonly eventId: string;
  readonly destinationKey: string;
  readonly provider: string;
  readonly occurredAt: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly reason: DeliveryFailure | null;
}

export interface DeliveryDiagnostics {
  readonly counts: Readonly<Record<DeliveryState, number>>;
  /** Original occurrence time of the oldest pending or claimed delivery, in epoch ms. */
  readonly oldestPendingAt: number | null;
}

export interface ClaimOptions {
  readonly now: number;
  readonly limit: number;
  readonly leaseMs: number;
}

/**
 * Times outside the event envelope use epoch milliseconds. An owner may renew
 * or settle only while its current claim has leaseUntil > now. Every mutation
 * must enforce its predicate in storage, including after locating candidates.
 */
export interface AnalyticsStore {
  /** Verify the extension and reserve the immutable key/provider bindings. */
  ready(destinations: readonly AnalyticsDestination[]): Promise<void>;
  /** Claim due pending records or expired claims for this exact key/provider. */
  claim(destination: AnalyticsDestination, options: ClaimOptions): Promise<ClaimedDelivery[]>;
  settle(ref: ClaimRef, transition: DeliveryTransition, now: number): Promise<boolean>;
  renew(ref: ClaimRef, leaseUntil: number, now: number): Promise<boolean>;
  /** Page in ascending destination key order. after is an exclusive key. */
  destinations(after: string | null, limit: number): Promise<AnalyticsDestination[]>;
  inspect(destinationKey: string, state: DeliveryState, limit: number): Promise<DeliverySummary[]>;
  diagnostics(destinationKey: string): Promise<DeliveryDiagnostics>;
  /** Reset a terminal failure's attempt count and schedule the original snapshot. */
  redrive(destinationKey: string, eventId: string, now: number): Promise<boolean>;
  /** Delete only delivered/failed history finalized strictly before the cutoff. */
  prune(destinationKey: string, before: number, limit: number): Promise<number>;
  /** Explicit retirement. Remove pending or expired claims, retaining active leases. */
  purge(destinationKey: string, now: number, limit: number): Promise<number>;
}
