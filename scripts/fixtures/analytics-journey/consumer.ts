import type pg from "pg";

import { createAnalyticsWorker, type AnalyticsAdaptor } from "@frostme/xp/analytics";
import { createAmplitudeAdaptor } from "@frostme/xp/analytics/amplitude";
import { createFullstoryAdaptor } from "@frostme/xp/analytics/fullstory";
import { createHeapAdaptor } from "@frostme/xp/analytics/heap";
import { createMixpanelAdaptor } from "@frostme/xp/analytics/mixpanel";
import { createPostHogAdaptor } from "@frostme/xp/analytics/posthog";
import { createSegmentAdaptor } from "@frostme/xp/analytics/segment";
import { initializeXp } from "@frostme/xp/server";

const providers = ["amplitude", "segment", "mixpanel", "fullstory", "heap", "posthog"] as const;
type Provider = (typeof providers)[number];

export const capture = {
  destinations: providers.map((provider) => ({ key: provider + "-shop", provider })),
  mapIdentity({ userId, destination }: { userId: string | number; destination: { key: string } }) {
    return userId === "shopper" ? "external-" + destination.key : null;
  },
};

export function startShop(connection: pg.Pool) {
  return initializeXp({ connection, analytics: capture });
}

// The journey supplies synthetic credentials and routes HTTP to six loopback receivers.
export function startWorker(
  connection: pg.Pool,
  request: (provider: Provider) => typeof fetch,
  only?: Provider,
) {
  const adaptors = {
    "amplitude-shop": createAmplitudeAdaptor({
      apiKey: "amplitude-fixture",
      fetch: request("amplitude"),
    }),
    "segment-shop": createSegmentAdaptor({
      writeKey: "segment-fixture",
      fetch: request("segment"),
    }),
    "mixpanel-shop": createMixpanelAdaptor({
      projectId: "42",
      username: "fixture-account",
      password: "fixture-password",
      fetch: request("mixpanel"),
    }),
    "fullstory-shop": createFullstoryAdaptor({
      apiKey: "fullstory-fixture",
      fetch: request("fullstory"),
    }),
    "heap-shop": createHeapAdaptor({ appId: "12345", fetch: request("heap") }),
    "posthog-shop": createPostHogAdaptor({
      projectToken: "phc_fixture",
      fetch: request("posthog"),
    }),
  };
  return createAnalyticsWorker({
    connection,
    adaptors: only ? { [only + "-shop"]: adaptors[`${only}-shop`] } : adaptors,
    batchSize: 6,
    parallelism: 6,
    // The killed worker leaves a short lease. Healthy workers have enough time for cold HTTP and database connections.
    leaseMs: only ? 6_000 : 15_000,
    requestTimeoutMs: 4_000,
    baseDelayMs: 50,
    maxDelayMs: 2_000,
    maxAttempts: 6,
    pollMs: 25,
  });
}

/** A host-owned table keyed by the original occurrence UUID makes replay idempotent. */
export function createWarehouseAdaptor(connection: pg.Pool): AnalyticsAdaptor {
  return {
    provider: "custom:warehouse",
    async deliver({ event, subjectId }, signal) {
      signal.throwIfAborted();
      await connection.query(
        "INSERT INTO warehouse_joins (event_id, subject_id, event) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING",
        [event.id, subjectId, event],
      );
      return { status: "accepted" };
    },
  };
}
