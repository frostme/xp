import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeXp } from "~/server";

import type { StorageFixture, experimentInput } from "./contract";

const flag = { slug: "cta", cohorts: ["off", "on"] };
const delivery = { slug: "delivery-copy", cohorts: ["control", "short"] };

export function registerStartupContract(
  current: () => StorageFixture,
  makeExperiment: typeof experimentInput,
) {
  describe("runtime startup", () => {
    let cwd: string;
    const boot = () => initializeXp({ ...current().startupOptions, cwd });
    const config = (experiments: unknown[]) =>
      writeFile(join(cwd, "xp.config.json"), JSON.stringify({ experiments }));
    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "xp-boot-"));
    });
    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    it("seeds once across racing initializers and maps a sticky off flag to the public default", async () => {
      const { adaptor, seedUser } = current();
      await config([flag]);
      const runs = await Promise.all([boot(), boot()]);
      expect(runs.flatMap((run) => run.seedReport.created)).toEqual(["cta"]);
      expect(runs.flatMap((run) => run.seedReport.skipped)).toEqual(["cta"]);
      const runtime = await boot();
      expect(runtime.seedReport).toEqual({ created: [], skipped: ["cta"] });
      const exp = await adaptor.experimentDAO.findBySlug("cta");
      expect(exp?.cohorts).toHaveLength(2);
      await expect(runtime.resolveCohort(undefined, "cta")).resolves.toEqual({ slug: null });
      await expect(runtime.resolveCohort("missing", "cta")).resolves.toEqual({ slug: null });
      await seedUser("customer");
      await runtime.joinCohort("customer", "cta", "cta_off");
      await expect(runtime.getGroup("customer", "cta")).resolves.toBe("cta_off");
      await expect(runtime.resolveCohort("customer", "cta")).resolves.toEqual({ slug: null });
      await runtime.finalizeExperiment(exp!.id, exp!.cohorts.find((c) => c.slug === "cta_on")!.id);
      await expect(runtime.resolveCohort("customer", "cta")).resolves.toEqual({ slug: "cta_on" });
      await runtime.pauseExperiment("cta");
      await expect(runtime.resolveCohort("customer", "cta")).resolves.toEqual({ slug: null });
      await runtime.resumeExperiment("cta");
      await expect(runtime.resolveCohort("customer", "cta")).resolves.toEqual({ slug: "cta_on" });
    });

    it("validates the entire config file before writing any experiment", async () => {
      const { adaptor } = current();
      await config([flag, { ...delivery, cohorts: ["control", "not_valid"] }]);
      await expect(boot()).rejects.toThrow("$.experiments[1].cohorts[1]");
      expect(await adaptor.experimentDAO.list()).toEqual([]);
      if ("tableName" in current().startupOptions) {
        await config([
          flag,
          { ...delivery, cohorts: Array.from({ length: 33 }, (_, i) => `variant-${i}`) },
        ]);
        await expect(boot()).rejects.toThrow("$.experiments[1].cohorts");
        expect(await adaptor.experimentDAO.list()).toEqual([]);
      }
    });

    it("preserves programmatically managed experiments when config changes or removes a declaration", async () => {
      const { adaptor, server, seedUser } = current();
      const created = await server.createExperiment(makeExperiment("existing-experiment"));
      await seedUser("customer");
      const [first, second] = created.cohorts;
      await server.joinCohort("customer", created.slug, first!.slug);
      await server.finalizeExperiment(created.id, second!.id);
      const previous = await adaptor.experimentDAO.getById(created.id);
      const membership = await adaptor.userDAO.findUserCohort("customer", created.id);
      await config([{ slug: created.slug, cohorts: ["control", "treatment", "new"] }, delivery]);
      expect((await boot()).seedReport).toEqual({
        created: ["delivery-copy"],
        skipped: [created.slug],
      });
      await config([delivery]);
      const next = await boot();
      expect(next.seedReport).toEqual({ created: [], skipped: ["delivery-copy"] });
      const after = await adaptor.experimentDAO.getById(created.id);
      expect({
        ...after,
        cohorts: [...after.cohorts].sort((a, b) => a.slug.localeCompare(b.slug)),
      }).toEqual({
        ...previous,
        cohorts: [...previous.cohorts].sort((a, b) => a.slug.localeCompare(b.slug)),
      });
      expect(await adaptor.userDAO.findUserCohort("customer", created.id)).toEqual(membership);
      expect(await next.resolveCohort("customer", created.slug)).toEqual({ slug: second!.slug });
    });

    it("rolls back a second-cohort collision, retaining earlier experiments and resuming on retry", async () => {
      const { adaptor } = current();
      const blocker = makeExperiment("blocking-experiment");
      // Storage enforces global uniqueness, even for legacy rows created directly via the DAO.
      blocker.cohorts[1]!.slug = "delivery-copy_short";
      const existing = await adaptor.experimentDAO.create(blocker);
      await config([flag, delivery]);
      await expect(boot()).rejects.toThrow();
      expect(await adaptor.experimentDAO.findBySlug("cta")).not.toBeNull();
      expect(await adaptor.experimentDAO.findBySlug("delivery-copy")).toBeNull();
      expect(await adaptor.cohortDAO.findBySlug("delivery-copy_control")).toBeNull();
      await adaptor.experimentDAO.remove(existing.id);
      expect((await boot()).seedReport).toEqual({ created: ["delivery-copy"], skipped: ["cta"] });
      expect((await adaptor.experimentDAO.findBySlug("delivery-copy"))?.cohorts).toHaveLength(2);
    });
  });
}
