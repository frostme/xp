import type { JsonValue } from "type-fest";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreationPayload, Experiment, CohortSlug, ExperimentSlug, PKey } from "~/entities";
import type { ServerFramework } from "~/frameworks";
import type { IDataAccessAdaptor } from "~/interfaces";

import { DuplicateAssignmentError, NotFoundError } from "~/errors";

export interface StorageFixture {
  adaptor: IDataAccessAdaptor;
  server: ServerFramework;
  seedUser(id: string): Promise<void>;
  cleanup(): Promise<void>;
}

const databases = ["postgres", "mysql", "mssql", "mongodb", "dynamodb"] as const;
type Database = (typeof databases)[number];

export function selectedDatabase(): Database {
  const selected = process.env["XP_DATABASE"] ?? "postgres";
  if (!databases.includes(selected as Database)) {
    throw new Error(`Unknown XP_DATABASE '${selected}'. Expected ${databases.join(", ")}.`);
  }
  return selected as Database;
}

export function experimentInput(slug = "checkout-test"): CreationPayload<Experiment> {
  return {
    name: slug.replaceAll("-", " "),
    slug,
    description: "A storage contract experiment",
    type: "simple",
    cohorts: [
      {
        slug: `${slug}_control`,
        description: "Control",
        type: "control",
        percentage: 40,
        value: { id: "application-value-id", enabled: false, nested: [0, null, "value"] },
      },
      {
        slug: `${slug}_treatment`,
        description: "Treatment",
        type: "treatment",
        percentage: 60,
        value: true,
      },
    ],
  } as CreationPayload<Experiment>;
}

const userId = "contract-user" as PKey<"User">;
const anotherUserId = "another-user" as PKey<"User">;
const missingExperimentId = -1 as PKey<"Experiment">;
const missingCohortId = -1 as PKey<"Cohort">;

function sortedCohorts(experiment: Experiment) {
  return [...experiment.cohorts].sort((left, right) => left.slug.localeCompare(right.slug));
}

export function registerStorageContract(name: Database, setup: () => Promise<StorageFixture>) {
  describe.skipIf(selectedDatabase() !== name)(`${name} storage contract`, () => {
    let fixture: StorageFixture | undefined;

    beforeEach(async () => {
      fixture = await setup();
    }, 60_000);

    afterEach(async () => {
      await fixture?.cleanup();
      fixture = undefined;
    }, 60_000);

    const current = () => {
      if (!fixture) throw new Error("Storage fixture is not initialized");
      return fixture;
    };

    it("creates and hydrates complete experiments with supplied percentages and primitive IDs", async () => {
      const { adaptor } = current();
      const input = experimentInput();
      const created = await adaptor.experimentDAO.create(input);
      expect(["string", "number"]).toContain(typeof created.id);
      expect(created.winner).toBeNull();
      expect(created.cohorts).toHaveLength(2);
      for (const cohort of created.cohorts) {
        expect(["string", "number"]).toContain(typeof cohort.id);
        const supplied = input.cohorts.find((entry) => entry.slug === cohort.slug)!;
        expect(cohort).toMatchObject(supplied);
        expect(await adaptor.cohortDAO.getById(cohort.id)).toMatchObject({
          ...cohort,
          experiment_id: created.id,
        });
      }
      const byId = await adaptor.experimentDAO.getById(created.id);
      const bySlug = await adaptor.experimentDAO.findBySlug(created.slug);
      const listed = await adaptor.experimentDAO.list();
      expect(byId).toMatchObject({ id: created.id, name: input.name, winner: null });
      expect(sortedCohorts(byId)).toEqual(sortedCohorts(created));
      expect(sortedCohorts(bySlug!)).toEqual(sortedCohorts(created));
      expect(listed).toHaveLength(1);
      expect(sortedCohorts(listed[0]!)).toEqual(sortedCohorts(created));
    });

    it("updates experiments and independently addressable cohorts", async () => {
      const { adaptor } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      const cohort = created.cohorts[0]!;
      await adaptor.experimentDAO.update(created.id, { description: "Changed experiment" });
      await adaptor.cohortDAO.update(cohort.id, { description: "Changed cohort", percentage: 25 });
      expect(await adaptor.cohortDAO.findBySlug(cohort.slug)).toMatchObject({
        id: cohort.id,
        description: "Changed cohort",
        percentage: 25,
      });
      const updated = await adaptor.experimentDAO.getById(created.id);
      expect(updated.description).toBe("Changed experiment");
      expect(updated.cohorts.find((entry) => entry.id === cohort.id)?.percentage).toBe(25);
      const extra = await adaptor.cohortDAO.create({
        ...experimentInput().cohorts[1]!,
        slug: "checkout-test_extra" as CohortSlug,
        experiment_id: created.id,
      });
      expect(extra.slug).toBe("checkout-test_extra");
      expect(await adaptor.cohortDAO.getByExperimentId(created.id)).toHaveLength(3);
    });

    it.each(
      (
        [
          null,
          false,
          true,
          0,
          1.25,
          "a JSON string",
          [0, false, null],
          { id: "keep", deep: { value: [1, "x"] } },
        ] as JsonValue[]
      ).map((value) => ({ value })),
    )("round trips JSON value $value without coercion", async ({ value }) => {
      const { adaptor } = current();
      const input = experimentInput();
      input.cohorts[0]!.value = value;
      const created = await adaptor.experimentDAO.create(input);
      const cohort = created.cohorts.find((entry) => entry.slug.endsWith("_control"))!;
      expect(cohort.value).toEqual(value);
      expect((await adaptor.cohortDAO.getById(cohort.id)).value).toEqual(value);
      expect((await adaptor.cohortDAO.findBySlug(cohort.slug))?.value).toEqual(value);
    });

    it("distinguishes required ID reads from optional lookups", async () => {
      const { adaptor } = current();
      await expect(adaptor.experimentDAO.getById(missingExperimentId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(adaptor.cohortDAO.getById(missingCohortId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(adaptor.userDAO.findById(userId)).rejects.toBeInstanceOf(NotFoundError);
      expect(
        await adaptor.experimentDAO.findBySlug("missing-experiment" as ExperimentSlug),
      ).toBeNull();
      expect(
        await adaptor.cohortDAO.findBySlug("missing-experiment_control" as CohortSlug),
      ).toBeNull();
      expect(await adaptor.cohortDAO.getByExperimentId(missingExperimentId)).toEqual([]);
      expect(await adaptor.userDAO.findUserCohort(userId, missingExperimentId)).toBeNull();
    });

    it("treats empty updates and writes to missing records as no-ops", async () => {
      const { adaptor } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      const cohort = created.cohorts[0]!;
      await adaptor.experimentDAO.update(created.id, {});
      await adaptor.cohortDAO.update(cohort.id, {});
      await adaptor.experimentDAO.update(missingExperimentId, { description: "Missing" });
      await adaptor.cohortDAO.update(missingCohortId, { percentage: 20 });
      await adaptor.experimentDAO.remove(missingExperimentId);
      await adaptor.cohortDAO.remove(missingCohortId);
      await adaptor.userDAO.removeUserCohort(userId, missingExperimentId);
      const unchanged = await adaptor.experimentDAO.getById(created.id);
      expect({ ...unchanged, cohorts: sortedCohorts(unchanged) }).toEqual({
        ...created,
        cohorts: sortedCohorts(created),
      });
    });

    it("enforces experiment and global cohort slug uniqueness", async () => {
      const { adaptor } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      await expect(adaptor.experimentDAO.create(experimentInput())).rejects.toThrow();
      await expect(
        adaptor.cohortDAO.create({
          ...experimentInput().cohorts[0]!,
          experiment_id: created.id,
        }),
      ).rejects.toThrow();
      expect(await adaptor.experimentDAO.list()).toHaveLength(1);
      expect(await adaptor.cohortDAO.getByExperimentId(created.id)).toHaveLength(2);
    });

    it("rolls back an entire experiment when a later initial cohort conflicts", async () => {
      const { adaptor } = current();
      const original = await adaptor.experimentDAO.create(experimentInput());
      const input = experimentInput("atomic-experiment");
      input.cohorts[1]!.slug = original.cohorts[0]!.slug;
      await expect(adaptor.experimentDAO.create(input)).rejects.toThrow();
      expect(await adaptor.experimentDAO.findBySlug(input.slug)).toBeNull();
      expect(await adaptor.cohortDAO.findBySlug(input.cohorts[0]!.slug)).toBeNull();
      expect(await adaptor.experimentDAO.list()).toHaveLength(1);
    });

    it("joins, finds, removes, and rejoins a user's experiment assignment", async () => {
      const { adaptor, seedUser } = current();
      await seedUser(userId);
      expect(await adaptor.userDAO.findById(userId)).toMatchObject({ id: userId });
      const created = await adaptor.experimentDAO.create(experimentInput());
      const membership = await adaptor.userDAO.addUserCohort(
        userId,
        created.id,
        created.cohorts[0]!.id,
      );
      expect(membership).toMatchObject({
        user_id: userId,
        experiment_id: created.id,
        cohort_id: created.cohorts[0]!.id,
      });
      expect(["string", "number"]).toContain(typeof membership.id);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toEqual(membership);
      await expect(
        adaptor.userDAO.addUserCohort(userId, created.id, created.cohorts[1]!.id),
      ).rejects.toBeInstanceOf(DuplicateAssignmentError);
      await adaptor.userDAO.removeUserCohort(userId, created.id);
      await adaptor.userDAO.removeUserCohort(userId, created.id);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
      const replacement = await adaptor.userDAO.addUserCohort(
        userId,
        created.id,
        created.cohorts[1]!.id,
      );
      expect(replacement.id).not.toBe(membership.id);
      expect(replacement.cohort_id).toBe(created.cohorts[1]!.id);
    });

    it("rejects assignments with missing users, missing parents, or foreign cohorts", async () => {
      const { adaptor, seedUser } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      const other = await adaptor.experimentDAO.create(experimentInput("other-experiment"));
      await expect(
        adaptor.userDAO.addUserCohort(userId, created.id, created.cohorts[0]!.id),
      ).rejects.toThrow();
      await seedUser(userId);
      await expect(
        adaptor.userDAO.addUserCohort(userId, missingExperimentId, created.cohorts[0]!.id),
      ).rejects.toThrow();
      await expect(
        adaptor.userDAO.addUserCohort(userId, created.id, missingCohortId),
      ).rejects.toThrow();
      await expect(
        adaptor.userDAO.addUserCohort(userId, created.id, other.cohorts[0]!.id),
      ).rejects.toThrow();
      await expect(
        adaptor.cohortDAO.create({
          ...experimentInput().cohorts[0]!,
          slug: "missing-experiment_extra" as CohortSlug,
          experiment_id: missingExperimentId,
        }),
      ).rejects.toThrow();
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
    });

    it("permits exactly one concurrent assignment for a user and experiment", async () => {
      const { adaptor, seedUser } = current();
      await seedUser(userId);
      const created = await adaptor.experimentDAO.create(experimentInput());
      const results = await Promise.allSettled(
        created.cohorts.map((cohort) =>
          adaptor.userDAO.addUserCohort(userId, created.id, cohort.id),
        ),
      );
      const successes = results.filter((result) => result.status === "fulfilled");
      const failures = results.filter((result) => result.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.reason).toBeInstanceOf(DuplicateAssignmentError);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toEqual(successes[0]!.value);
    });

    it("clears a deleted winner and cascades only that cohort's assignments", async () => {
      const { adaptor, seedUser } = current();
      await seedUser(userId);
      await seedUser(anotherUserId);
      const created = await adaptor.experimentDAO.create(experimentInput());
      const [winner, remaining] = created.cohorts;
      await adaptor.userDAO.addUserCohort(userId, created.id, winner!.id);
      await adaptor.userDAO.addUserCohort(anotherUserId, created.id, remaining!.id);
      await adaptor.experimentDAO.update(created.id, { winner: winner!.slug });
      await adaptor.cohortDAO.remove(winner!.id);
      await adaptor.cohortDAO.remove(winner!.id);
      const updated = await adaptor.experimentDAO.getById(created.id);
      expect(updated.winner).toBeNull();
      expect(updated.cohorts).toHaveLength(1);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
      expect(await adaptor.userDAO.findUserCohort(anotherUserId, created.id)).toMatchObject({
        cohort_id: remaining!.id,
      });
      expect(await adaptor.cohortDAO.findBySlug(winner!.slug)).toBeNull();
    });

    it("does not finalize a replacement cohort after its predecessor's slug is reused", async () => {
      const { adaptor } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      const original = created.cohorts[0]!;
      await adaptor.cohortDAO.remove(original.id);
      const replacement = await adaptor.cohortDAO.create({
        ...experimentInput().cohorts[0]!,
        slug: original.slug,
        experiment_id: created.id,
      });
      await expect(
        adaptor.experimentDAO.update(created.id, { winner: original.slug }, original.id),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await adaptor.experimentDAO.getById(created.id)).winner).toBeNull();
      await adaptor.experimentDAO.update(created.id, { winner: replacement.slug }, replacement.id);
      expect((await adaptor.experimentDAO.getById(created.id)).winner).toBe(replacement.slug);
    });

    it("cascades experiment deletion without deleting users or other experiments", async () => {
      const { adaptor, seedUser } = current();
      await seedUser(userId);
      const created = await adaptor.experimentDAO.create(experimentInput());
      const other = await adaptor.experimentDAO.create(experimentInput("other-experiment"));
      await adaptor.userDAO.addUserCohort(userId, created.id, created.cohorts[0]!.id);
      await adaptor.userDAO.addUserCohort(userId, other.id, other.cohorts[0]!.id);
      await adaptor.experimentDAO.remove(created.id);
      await adaptor.experimentDAO.remove(created.id);
      expect(await adaptor.experimentDAO.findBySlug(created.slug)).toBeNull();
      expect(await adaptor.cohortDAO.getByExperimentId(created.id)).toEqual([]);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
      for (const cohort of created.cohorts) {
        expect(await adaptor.cohortDAO.findBySlug(cohort.slug)).toBeNull();
        await expect(adaptor.cohortDAO.getById(cohort.id)).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(await adaptor.userDAO.findById(userId)).toMatchObject({ id: userId });
      expect(await adaptor.userDAO.findUserCohort(userId, other.id)).not.toBeNull();
      expect(await adaptor.experimentDAO.list()).toHaveLength(1);
    });

    it("does not leave children behind when experiment removal races insertion", async () => {
      const { adaptor, seedUser } = current();
      await seedUser(userId);
      const created = await adaptor.experimentDAO.create(experimentInput());
      const extraSlug = "checkout-test_extra" as CohortSlug;
      const results = await Promise.allSettled([
        adaptor.experimentDAO.remove(created.id),
        adaptor.cohortDAO.create({
          ...experimentInput().cohorts[1]!,
          slug: extraSlug,
          experiment_id: created.id,
        }),
        adaptor.userDAO.addUserCohort(userId, created.id, created.cohorts[0]!.id),
      ]);
      // A transient conflict is allowed, but repeating a failed delete must finish its work.
      if (results[0]!.status === "rejected") await adaptor.experimentDAO.remove(created.id);
      expect(await adaptor.experimentDAO.findBySlug(created.slug)).toBeNull();
      expect(await adaptor.cohortDAO.getByExperimentId(created.id)).toEqual([]);
      expect(await adaptor.cohortDAO.findBySlug(extraSlug)).toBeNull();
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
    });

    it("never leaves a stale winner when finalization races cohort removal", async () => {
      const { adaptor } = current();
      const created = await adaptor.experimentDAO.create(experimentInput());
      const cohort = created.cohorts[0]!;
      const results = await Promise.allSettled([
        adaptor.cohortDAO.remove(cohort.id),
        adaptor.experimentDAO.update(created.id, { winner: cohort.slug }),
      ]);
      if (results[0]!.status === "rejected") await adaptor.cohortDAO.remove(cohort.id);
      expect((await adaptor.experimentDAO.getById(created.id)).winner).toBeNull();
      expect(await adaptor.cohortDAO.findBySlug(cohort.slug)).toBeNull();
    });

    it("runs the public server workflow and preserves JSON through validation", async () => {
      const { adaptor, server, seedUser } = current();
      await seedUser(userId);
      const input = experimentInput();
      const created = await server.createExperiment(input);
      const control = created.cohorts.find((cohort) => cohort.type === "control")!;
      const treatment = created.cohorts.find((cohort) => cohort.type === "treatment")!;
      expect(control.value).toEqual(input.cohorts[0]!.value);
      expect(control.percentage).toBe(40);
      await server.joinCohort(userId, created.slug, control.slug);
      await expect(server.joinCohort(userId, created.slug, treatment.slug)).rejects.toThrow();
      expect(await server.getGroup(userId, created.slug)).toBe(control.slug);
      await server.finalizeExperiment(created.id, treatment.id);
      expect(await server.getGroup(userId, created.slug)).toBe(treatment.slug);
      await server.removeCohort(treatment.id);
      expect(await server.getGroup(userId, created.slug)).toBe(control.slug);
      await server.leaveExperiment(userId, created.slug);
      expect(await adaptor.userDAO.findUserCohort(userId, created.id)).toBeNull();
      await server.removeExperiment(created.id);
      expect(await adaptor.experimentDAO.findBySlug(created.slug)).toBeNull();
    });

    it("returns the persisted cohort to every concurrent getGroup caller", async () => {
      const { adaptor, server, seedUser } = current();
      await seedUser(userId);
      const created = await server.createExperiment(experimentInput());
      const groups = await Promise.all(
        Array.from({ length: 6 }, () => server.getGroup(userId, created.slug)),
      );
      const membership = await adaptor.userDAO.findUserCohort(userId, created.id);
      const cohort = await adaptor.cohortDAO.getById(membership!.cohort_id);
      expect(groups).toEqual(Array.from({ length: 6 }, () => cohort.slug));
    });

    it("defaults an omitted cohort JSON value to null through server validation", async () => {
      const { server } = current();
      const input = experimentInput();
      const created = await server.createExperiment({
        ...input,
        cohorts: input.cohorts.map(({ value: _value, ...cohort }) => cohort),
      });
      expect(created.cohorts.map((cohort) => cohort.value)).toEqual([null, null]);
    });
  });
}
