import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { PKey } from "~/entities";
import type { ClaimedDelivery } from "~/interfaces/analytics";

import { initializeXp } from "~/server";

import type { StorageFixture } from "./contract";

type Fixture = StorageFixture & { applyAnalytics(): Promise<void> };

export function combined(label: string, setup: () => Promise<Fixture>) {
  it(`fences weighted draws and captures only committed joins on ${label}`, async () => {
    const f = await setup();
    const cwd = await mkdtemp(join(tmpdir(), "xp-combined-"));
    try {
      await writeFile(
        join(cwd, "xp.config.json"),
        JSON.stringify({
          experiments: [],
          management: { allowCreate: true },
        }),
      );
      for (const user of ["disabled", "pinned", "manual", "auto", "race", "finalize-race"]) {
        await f.seedUser(user as PKey<"User">);
      }
      const runtime = await initializeXp({ ...f.startupOptions, cwd, random: () => 0.0003 });
      const x = await runtime.management.create({ slug: "combined", cohorts: ["short", "long"] });
      const { id, slug } = x;
      const [off, short, long] = ["combined_off", "combined_short", "combined_long"] as const;
      const disabledAllocation = [
        { cohort: off, percentage: 0.03 },
        { cohort: short, percentage: 99.97 },
        { cohort: long, percentage: 0 },
      ];
      const counts = async () => {
        const detail = await runtime.management.detail(slug, "view");
        return Object.fromEntries(detail.cohorts.map((c) => [c.slug, c.memberships]));
      };
      const membership = (user: string) =>
        f.adaptor.userDAO.findUserCohort(user as PKey<"User">, id);

      // The optional analytics schema has not been provisioned yet.
      expect(await runtime.resolveCohort("pinned", slug)).toEqual({ slug: null });
      await runtime.management.apply(
        slug,
        1,
        { type: "launch", allocation: disabledAllocation },
        id,
      );
      expect(await runtime.resolveCohort("disabled", slug)).toEqual({ slug: short });
      expect(await counts()).toEqual({ [off]: 0, [short]: 1, [long]: 0 });
      await runtime.management.apply(slug, 2, { type: "finalize", cohort: off }, id);

      await f.applyAnalytics();
      const destination = { key: "cohort-events", provider: "custom:test" };
      const gates = new Map(
        ["race", "finalize-race"].map((user) => [
          user,
          {
            started: Promise.withResolvers<void>(),
            resume: Promise.withResolvers<void>(),
            waiting: false,
          },
        ]),
      );
      const mapped: string[] = [];
      const captured = await initializeXp({
        ...f.startupOptions,
        cwd,
        random: () => 0.2,
        analytics: {
          destinations: [destination],
          mappingTimeoutMs: 15000,
          async mapIdentity({ userId }) {
            mapped.push(String(userId));
            const gate = gates.get(String(userId));
            if (gate && !gate.waiting) {
              gate.waiting = true;
              gate.started.resolve();
              await gate.resume.promise;
            }
            return `subject-${userId}`;
          },
        },
      });
      const managed = await captured.management.create({
        slug: "together",
        cohorts: ["short", "long"],
      });
      const base = managed.slug;
      const offSlug = `${base}_off`,
        shortSlug = `${base}_short`,
        longSlug = `${base}_long`;
      const split = (offWeight: number) => [
        { cohort: offSlug, percentage: offWeight },
        { cohort: shortSlug, percentage: 100 - offWeight },
        { cohort: longSlug, percentage: 0 },
      ];
      const decide = (user: string) => captured.resolveCohort(user, base);
      const current = (user: string) =>
        f.adaptor.userDAO.findUserCohort(user as PKey<"User">, managed.id);
      const detailCounts = async () =>
        Object.fromEntries(
          (await captured.management.detail(base, "view")).cohorts.map((c) => [
            c.slug,
            c.memberships,
          ]),
        );
      const store = f.adaptor.analytics!;
      expect(await decide("pinned")).toEqual({ slug: null });
      expect(await current("pinned")).toBeNull();
      expect((await store.diagnostics(destination.key)).counts.pending).toBe(0);
      await captured.joinCohort("manual", base, shortSlug);
      expect(await decide("manual")).toEqual({ slug: null });

      await captured.management.apply(
        base,
        1,
        { type: "launch", allocation: split(21) },
        managed.id,
      );
      expect(await decide("auto")).toEqual({ slug: null });
      expect(await decide("auto")).toEqual({ slug: null });
      const offRow = managed.cohorts.find((c) => c.slug === offSlug)!;
      expect((await current("auto"))?.cohort_id).toBe(offRow.id);

      const race = decide("race");
      await gates.get("race")!.started.promise;
      await captured.management.apply(
        base,
        2,
        { type: "adjust", allocation: split(0) },
        managed.id,
      );
      gates.get("race")!.resume.resolve();
      expect(await race).toEqual({ slug: shortSlug });
      const shortRow = managed.cohorts.find((c) => c.slug === shortSlug)!;
      expect((await current("race"))?.cohort_id).toBe(shortRow.id);

      const finalizeRace = decide("finalize-race");
      await gates.get("finalize-race")!.started.promise;
      await captured.management.apply(base, 3, { type: "finalize", cohort: offSlug }, managed.id);
      gates.get("finalize-race")!.resume.resolve();
      expect(await finalizeRace).toEqual({ slug: null });
      expect(await current("finalize-race")).toBeNull();
      expect(mapped).toEqual(["manual", "auto", "race", "race", "finalize-race"]);

      const expectedCounts = { [offSlug]: 1, [shortSlug]: 2, [longSlug]: 0 };
      expect(await detailCounts()).toEqual(expectedCounts);
      const claimed: ClaimedDelivery[] = [];
      await expect
        .poll(async () => {
          claimed.push(
            ...(await store.claim(destination, { now: Date.now(), leaseMs: 30000, limit: 8 })),
          );
          return claimed.length;
        })
        .toBe(3);
      const payloads = claimed.map((r) => [r.subjectId, r.event.source, r.event.cohortSlug]);
      expect(payloads.sort()).toEqual([
        ["subject-auto", "automatic", offSlug],
        ["subject-manual", "manual", shortSlug],
        ["subject-race", "automatic", shortSlug],
      ]);
      expect(new Set(claimed.map((r) => r.event.id)).size).toBe(3);
      expect((await store.diagnostics(destination.key)).counts).toEqual({
        claimed: 3,
        delivered: 0,
        failed: 0,
        pending: 0,
      });
      expect(await detailCounts()).toEqual(expectedCounts);
      expect(await membership("disabled")).not.toBeNull();
    } finally {
      await f.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
