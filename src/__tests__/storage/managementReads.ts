import { describe, expect, it } from "vitest";

import type { Experiment, PKey } from "~/entities";
import type { IExperimentDAO } from "~/interfaces";
import type { DirectoryEntry } from "~/interfaces/management";

import { parseManagedDefinition } from "~/adaptors/validation/zod/seed";

import type { StorageFixture, experimentInput } from "./contract";

async function readDirectory(dao: IExperimentDAO, query = "", limit = 2) {
  const entries: DirectoryEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await dao.listPage({ query, limit, ...(cursor === null ? {} : { cursor }) });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    entries.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return entries;
}

export function registerManagementReadContract(
  current: () => StorageFixture,
  makeExperiment: typeof experimentInput,
) {
  describe("management reads", () => {
    it("paginates projected definitions and searches literal names and slugs case-insensitively", async () => {
      const { experimentDAO } = current().adaptor;
      expect(await readDirectory(experimentDAO)).toEqual([]);
      for (const limit of [0, 101])
        await expect(experimentDAO.listPage({ query: "", limit })).rejects.toMatchObject({
          name: "ValidationError",
        });
      const slugs = ["promotions", "checkout-layout", "dark-theme", "summer-sale", "managed-copy"];
      for (const slug of slugs.slice(0, -1)) {
        const input = makeExperiment(slug);
        if (slug === "summer-sale") input.name = "Autumn %_[.+ offer" as Experiment["name"];
        await experimentDAO.create(input);
      }
      await experimentDAO.create(
        parseManagedDefinition({ slug: "managed-copy", cohorts: ["sample"] }),
      );
      await experimentDAO.setEnabled("dark-theme", false);

      const directory = await readDirectory(experimentDAO);
      expect(directory.map((entry) => entry.slug).sort()).toEqual([...slugs].sort());
      for (const entry of directory) {
        expect(entry).not.toHaveProperty("cohorts");
        expect(entry).not.toHaveProperty("description");
      }
      expect(directory.find((row) => row.slug === "dark-theme")).toMatchObject({
        enabled: false,
        type: "simple",
        winner: null,
      });
      expect(directory.find((row) => row.slug === "managed-copy")).toMatchObject({
        enabled: true,
        winner: "managed-copy_off",
        rolloutPhase: "awaiting-launch",
      });
      for (const query of ["AuTuMn", "%_[.+", "%", "_", "."]) {
        expect((await readDirectory(experimentDAO, query)).map((item) => item.slug)).toEqual([
          "summer-sale",
        ]);
      }
      expect((await readDirectory(experimentDAO, "KOUT-LaY")).map((item) => item.slug)).toEqual([
        "checkout-layout",
      ]);
      expect(await readDirectory(experimentDAO, "no match")).toEqual([]);
    });

    it("counts current memberships including off, zeroes, and joins after a leave", async () => {
      const {
        adaptor: { experimentDAO },
        server,
        seedUser,
      } = current();
      const managed = await experimentDAO.create(
        parseManagedDefinition({ slug: "checkout-copy", cohorts: ["short", "long"] }),
      );
      const legacy = await experimentDAO.create(makeExperiment("legacy"));
      const alice = "alice" as PKey<"User">;
      const bob = "bob" as PKey<"User">;
      await seedUser(alice);
      await seedUser(bob);
      const off = managed.cohorts.find((cohort) => cohort.type === "control")!.slug;
      const short = managed.cohorts.find((cohort) => cohort.slug.endsWith("_short"))!.slug;
      const long = managed.cohorts.find((cohort) => cohort.slug.endsWith("_long"))!.slug;
      const counts = () => experimentDAO.countMemberships(managed);

      await server.getGroup(alice, managed.slug);
      expect(await counts()).toEqual({ [off]: 0, [short]: 0, [long]: 0 });
      await server.joinCohort(alice, managed.slug, off);
      await server.joinCohort(bob, managed.slug, short);
      const [legacyFirst, legacySecond] = legacy.cohorts;
      await server.joinCohort(bob, legacy.slug, legacyFirst!.slug);
      expect(await counts()).toEqual({ [off]: 1, [short]: 1, [long]: 0 });
      expect(await experimentDAO.countMemberships(legacy)).toEqual({
        [legacyFirst!.slug]: 1,
        [legacySecond!.slug]: 0,
      });
      await server.leaveExperiment(alice, managed.slug);
      expect(await counts()).toEqual({ [off]: 0, [short]: 1, [long]: 0 });
      await server.joinCohort(alice, managed.slug, short);
      expect(await counts()).toEqual({ [off]: 0, [short]: 2, [long]: 0 });
    });
  });
}
