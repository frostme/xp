import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CreationPayload, Cohort, PKey } from "~/entities";

import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";

import { mongoFixture } from "./fixture";

registerStorageContract("mongodb", mongoFixture);

describe.skipIf(selectedDatabase() !== "mongodb")("MongoDB transaction guarantees", () => {
  let fixture: Awaited<ReturnType<typeof mongoFixture>>;

  beforeEach(async () => {
    fixture = await mongoFixture();
  });

  afterEach(async () => {
    await fixture?.cleanup();
  });

  test("projects domain fields without MongoDB metadata", async () => {
    const created = await fixture.adaptor.experimentDAO.create(experimentInput());
    const loaded = await fixture.adaptor.experimentDAO.getById(created.id);
    expect(loaded).toEqual(created);
    expect(loaded).not.toHaveProperty("_id");
    expect(loaded).not.toHaveProperty("version");
    expect(loaded.cohorts[0]).not.toHaveProperty("_id");
    expect(typeof loaded.id).toBe("string");
    await fixture.seedUser("host-user");
    await fixture.client
      .db(fixture.databaseName)
      .collection("users")
      .updateOne({ id: "host-user" }, { $set: { email: "private@example.test", role: "admin" } });
    expect(await fixture.adaptor.userDAO.findById("host-user" as PKey<"User">)).toEqual({
      id: "host-user",
    });
  });

  test("concurrent cohort creation cannot survive experiment deletion", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = {
      slug: `${experiment.slug}_extra`,
      description: "Concurrent child",
      percentage: 0,
      value: null,
      type: "treatment",
      experiment_id: experiment.id,
    } as CreationPayload<Cohort> & { experiment_id: PKey<"Experiment"> };
    await Promise.allSettled([
      fixture.adaptor.cohortDAO.create(cohort),
      fixture.adaptor.experimentDAO.remove(experiment.id),
    ]);
    const db = fixture.client.db(fixture.databaseName);
    expect(await db.collection("experiments").countDocuments()).toBe(0);
    expect(await db.collection("cohorts").countDocuments()).toBe(0);
  });

  test("concurrent membership creation cannot survive cohort deletion", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = experiment.cohorts[0]!;
    await fixture.seedUser("racing-user");
    await Promise.allSettled([
      fixture.adaptor.userDAO.addUserCohort(
        "racing-user" as PKey<"User">,
        experiment.id,
        cohort.id,
      ),
      fixture.adaptor.cohortDAO.remove(cohort.id),
    ]);
    const db = fixture.client.db(fixture.databaseName);
    expect(await db.collection("user_cohorts").countDocuments()).toBe(0);
    expect(await db.collection("cohorts").countDocuments({ id: cohort.id })).toBe(0);
  });

  test("concurrent finalization cannot retain a deleted winner", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = experiment.cohorts[0]!;
    await Promise.allSettled([
      fixture.adaptor.experimentDAO.update(experiment.id, { winner: cohort.slug }),
      fixture.adaptor.cohortDAO.remove(cohort.id),
    ]);
    expect((await fixture.adaptor.experimentDAO.getById(experiment.id)).winner).toBeNull();
  });

  test("the application client remains usable after successful and failed transactions", async () => {
    await fixture.adaptor.experimentDAO.create(experimentInput());
    await expect(fixture.adaptor.experimentDAO.create(experimentInput())).rejects.toThrow();
    await expect(
      fixture.client.db(fixture.databaseName).command({ ping: 1 }),
    ).resolves.toHaveProperty("ok", 1);
  });

  test("finalizing a deleted cohort cannot select a replacement with the same slug", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const oldCohort = experiment.cohorts[0]!;
    await fixture.adaptor.cohortDAO.remove(oldCohort.id);
    const replacement = await fixture.adaptor.cohortDAO.create({
      ...experimentInput().cohorts[0]!,
      experiment_id: experiment.id,
    });
    expect(replacement.id).not.toBe(oldCohort.id);
    await expect(
      fixture.adaptor.experimentDAO.update(experiment.id, { winner: oldCohort.slug }, oldCohort.id),
    ).rejects.toThrow();
    expect((await fixture.adaptor.experimentDAO.getById(experiment.id)).winner).toBeNull();
    await fixture.adaptor.experimentDAO.update(
      experiment.id,
      { winner: replacement.slug },
      replacement.id,
    );
    expect((await fixture.adaptor.experimentDAO.getById(experiment.id)).winner).toBe(
      replacement.slug,
    );
  });
});
