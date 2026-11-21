import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import type { PKey } from "~/entities";

import { experimentInput } from "~/__tests__/storage/contract";
import { setupSequelize } from "~/adaptors/data-access/sequelize/__tests__/fixture";

import { setupMysql } from "./fixture";

it.each(["native", "sequelize"])(
  "avoids range-lock deadlocks with eight concurrent %s claimers",
  async (driver) => {
    const fixture = driver === "native" ? await setupMysql() : await setupSequelize("mysql");
    try {
      const store = fixture.adaptor.analytics!;
      const destination = { key: "mysql-claims", provider: "heap" };
      await fixture.applyAnalytics();
      await store.ready([destination]);
      const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
      const cohort = experiment.cohorts[0]!;
      const start = Date.now();
      for (let i = 0; i < 24; i++) {
        const id = `host-${i}` as PKey<"User">;
        await fixture.seedUser(id);
        await fixture.adaptor.userDAO.addUserCohort(id, experiment.id, cohort.id, [
          {
            event: {
              id: randomUUID(),
              occurredAt: new Date(start).toISOString(),
              name: "xp.cohort.joined",
              version: 1,
              cohortSlug: cohort.slug,
              experimentSlug: experiment.slug,
              source: "manual",
            },
            destinationKey: destination.key,
            provider: destination.provider,
            subjectId: `external-${i}`,
          },
        ]);
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const claim = () =>
          store.claim(destination, { now: start + 100 * attempt, limit: 2, leaseMs: 25 });
        const pages = await Promise.all(Array.from({ length: 8 }, claim));
        const ids = pages.flat().map((item) => item.event.id);
        expect(pages.every((page) => page.length <= 2)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeGreaterThan(0);
      }
    } finally {
      await fixture.cleanup();
    }
  },
);
