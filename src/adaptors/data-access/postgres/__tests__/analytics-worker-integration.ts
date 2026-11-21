import { describe, expect, it } from "vitest";

import type { AnalyticsAdaptor } from "~/interfaces/analytics";

import { experimentInput, selectedDatabase } from "~/__tests__/storage/contract";
import { createAnalyticsWorker } from "~/analytics";
import { initializeXp } from "~/server";

import { setupPostgres } from "./fixture";

describe.skipIf(selectedDatabase() !== "postgres")("host-run analytics", () => {
  it("recovers an unacknowledged acceptance, preserves peer progress, and re-drives a terminal row", async () => {
    const fixture = await setupPostgres();
    try {
      await fixture.applyAnalytics();
      const destinations = ["left", "right"].map((key) => ({ key, provider: "custom:recorder" }));
      const xp = await initializeXp({
        connection: fixture.pool,
        analytics: {
          destinations,
          mapIdentity: ({ destination }) => "external-" + destination.key,
        },
      });
      await fixture.seedUser("a");
      const exp = await xp.createExperiment(experimentInput());
      await xp.resolveCohort("a", exp.slug);
      const started = Promise.withResolvers<void>();
      const attempts: unknown[] = [];
      const broken = new AbortController();
      const left: AnalyticsAdaptor = {
        provider: "custom:recorder",
        async deliver(payload) {
          attempts.push(payload);
          started.resolve();
          return new Promise(() => {});
        },
      };
      const one = createAnalyticsWorker({ connection: fixture.pool, adaptors: { left } });
      const first = one.run({ signal: broken.signal });
      await started.promise;
      broken.abort();
      await first;
      expect((await one.diagnostics("left")).counts.claimed).toBe(1);
      await xp.removeExperiment(exp.id);
      // Advance only this fixture's stored lease so restart does not depend on wall-clock sleeps.
      await fixture.pool.query(
        "UPDATE xp_analytics_deliveries SET due_at = 0 WHERE state = 'claimed'",
      );
      let repaired = false;
      const two = createAnalyticsWorker({
        connection: fixture.pool,
        adaptors: {
          left: {
            provider: "custom:recorder",
            async deliver(payload) {
              attempts.push(payload);
              return { status: "accepted" };
            },
          },
          right: {
            provider: "custom:recorder",
            async deliver() {
              return repaired
                ? { status: "accepted" }
                : { status: "rejected", reason: "unauthorized" };
            },
          },
        },
      });
      expect(await two.drainOnce()).toMatchObject({ claimed: 2, delivered: 1, failed: 1 });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toEqual(attempts[1]);
      const [dead] = await two.inspect("right", "failed");
      expect(dead?.reason).toBe("unauthorized");
      expect(JSON.stringify(dead)).not.toContain("external-");
      repaired = true;
      expect(await two.redrive("right", dead!.eventId)).toBe(true);
      expect(await two.drainOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    } finally {
      await fixture.cleanup();
    }
  }, 30000);
});
