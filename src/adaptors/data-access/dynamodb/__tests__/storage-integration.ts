import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CohortSlug, PKey } from "~/entities";

import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";

import DynamoDBAdaptor from "..";
import { dynamodbFixture } from "./fixture";

registerStorageContract("dynamodb", dynamodbFixture);

describe.skipIf(selectedDatabase() !== "dynamodb")("DynamoDB limits and resumable cleanup", () => {
  let fixture: Awaited<ReturnType<typeof dynamodbFixture>>;
  beforeEach(async () => {
    fixture = await dynamodbFixture();
  });
  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("creates 32 initial cohorts atomically, rejects 33, and can add more later", async () => {
    const input = experimentInput();
    input.cohorts = Array.from({ length: 32 }, (_, index) => ({
      ...input.cohorts[0]!,
      slug: `${input.slug}_cohort-${index}` as CohortSlug,
    }));
    const experiment = await fixture.adaptor.experimentDAO.create(input);
    expect(experiment.cohorts).toHaveLength(32);
    expect(await fixture.adaptor.cohortDAO.getByExperimentId(experiment.id)).toHaveLength(32);
    await fixture.adaptor.cohortDAO.create({
      ...input.cohorts[0]!,
      slug: `${input.slug}_added` as CohortSlug,
      experiment_id: experiment.id,
    });
    expect(await fixture.adaptor.cohortDAO.getByExperimentId(experiment.id)).toHaveLength(33);
    const before = await fixture.items();
    await expect(
      fixture.adaptor.experimentDAO.create({
        ...input,
        cohorts: [...input.cohorts, input.cohorts[0]!],
      }),
    ).rejects.toThrow("32 initial cohorts");
    expect(await fixture.items()).toHaveLength(before.length);
  });

  it("rejects an oversized item without leaving any experiment records", async () => {
    const input = experimentInput();
    input.cohorts[0]!.value = "x".repeat(401 * 1024);
    await expect(fixture.adaptor.experimentDAO.create(input)).rejects.toThrow();
    expect(await fixture.items()).toEqual([]);
  });

  it("rejects an oversized transaction atomically", async () => {
    const input = experimentInput();
    input.cohorts = Array.from({ length: 16 }, (_, index) => ({
      ...input.cohorts[0]!,
      slug: `${input.slug}_cohort-${index}` as CohortSlug,
      value: "x".repeat(300 * 1024),
    }));
    await expect(fixture.adaptor.experimentDAO.create(input)).rejects.toThrow();
    expect(await fixture.items()).toEqual([]);
  });

  it("keeps string and numeric user IDs separate", async () => {
    await fixture.seedPrimitiveUser(1);
    await fixture.seedPrimitiveUser("1");
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const numeric = await fixture.adaptor.userDAO.addUserCohort(
      1 as PKey<"User">,
      experiment.id,
      experiment.cohorts[0]!.id,
    );
    const string = await fixture.adaptor.userDAO.addUserCohort(
      "1" as PKey<"User">,
      experiment.id,
      experiment.cohorts[1]!.id,
    );
    expect(numeric.id).not.toEqual(string.id);
    expect(
      (await fixture.adaptor.userDAO.findUserCohort(1 as PKey<"User">, experiment.id))?.cohort_id,
    ).toEqual(experiment.cohorts[0]!.id);
    expect(
      (await fixture.adaptor.userDAO.findUserCohort("1" as PKey<"User">, experiment.id))?.cohort_id,
    ).toEqual(experiment.cohorts[1]!.id);
  });

  it("hides a deleting experiment, blocks writes, and resumes an interrupted cascade", async () => {
    const userId = "cleanup-user" as PKey<"User">;
    await fixture.seedUser(userId);
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    await fixture.adaptor.userDAO.addUserCohort(userId, experiment.id, experiment.cohorts[0]!.id);
    const client = {
      send: async (command: any) => {
        if (
          command instanceof TransactWriteCommand &&
          command.input.TransactItems?.some((item) =>
            item.Delete?.Key?.["sk"]?.toString().startsWith("M#"),
          )
        ) {
          throw new Error("Injected cleanup interruption");
        }
        return fixture.client.send(command);
      },
    } as DynamoDBDocumentClient;
    const interrupted = new DynamoDBAdaptor(client, fixture.tableName);
    await expect(interrupted.experimentDAO.remove(experiment.id)).rejects.toThrow(
      "Injected cleanup interruption",
    );
    expect(await fixture.adaptor.experimentDAO.findBySlug(experiment.slug)).toBeNull();
    expect(await fixture.adaptor.cohortDAO.findBySlug(experiment.cohorts[0]!.slug)).toBeNull();
    await expect(
      fixture.adaptor.cohortDAO.create({
        ...experimentInput().cohorts[0]!,
        slug: "checkout-test_late" as CohortSlug,
        experiment_id: experiment.id,
      }),
    ).rejects.toThrow();
    await expect(fixture.adaptor.experimentDAO.create(experimentInput())).rejects.toThrow();
    await fixture.adaptor.experimentDAO.remove(experiment.id);
    expect((await fixture.items()).filter((item) => !item["pk"].startsWith("USER#"))).toEqual([]);
    await expect(fixture.adaptor.experimentDAO.create(experimentInput())).resolves.toBeDefined();
  });

  it("drains multiple cleanup pages and permits overlapping cohort/experiment deletion", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    for (let index = 0; index < 30; index += 1) {
      const id = `user-${index}` as PKey<"User">;
      await fixture.seedUser(id);
      await fixture.adaptor.userDAO.addUserCohort(id, experiment.id, experiment.cohorts[0]!.id);
    }
    await Promise.all([
      fixture.adaptor.experimentDAO.remove(experiment.id),
      fixture.adaptor.cohortDAO.remove(experiment.cohorts[0]!.id),
    ]);
    expect((await fixture.items()).filter((item) => !item["pk"].startsWith("USER#"))).toEqual([]);
  });
  it("does not delete a replacement assignment when cleanup races leave/rejoin", async () => {
    const userId = "rejoin-user" as PKey<"User">;
    await fixture.seedUser(userId);
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = experiment.cohorts[0]!;
    await fixture.adaptor.userDAO.addUserCohort(userId, experiment.id, cohort.id);
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let intercepted = false;
    const client = {
      send: async (command: any) => {
        if (
          !intercepted &&
          command instanceof TransactWriteCommand &&
          command.input.TransactItems?.some((item) =>
            item.Delete?.Key?.["sk"]?.toString().startsWith("M#"),
          )
        ) {
          intercepted = true;
          reached();
          await resumed;
        }
        return fixture.client.send(command);
      },
    } as DynamoDBDocumentClient;
    const cleanup = new DynamoDBAdaptor(client, fixture.tableName).cohortDAO.remove(cohort.id);
    await paused;
    let replacement;
    try {
      await fixture.adaptor.userDAO.removeUserCohort(userId, experiment.id);
      replacement = await fixture.adaptor.userDAO.addUserCohort(
        userId,
        experiment.id,
        experiment.cohorts[1]!.id,
      );
    } finally {
      resume();
    }
    await cleanup;
    expect(await fixture.adaptor.userDAO.findUserCohort(userId, experiment.id)).toEqual(
      replacement,
    );
  });

  it("does not release a reused slug when an older cleanup resumes", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = experiment.cohorts[0]!;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let intercepted = false;
    const client = {
      send: async (command: any) => {
        if (
          !intercepted &&
          command instanceof TransactWriteCommand &&
          command.input.TransactItems?.some(
            (item) => item.Delete?.Key?.["pk"] === `COHORT_SLUG#${cohort.slug}`,
          )
        ) {
          intercepted = true;
          reached();
          await resumed;
        }
        return fixture.client.send(command);
      },
    } as DynamoDBDocumentClient;
    const cleanup = new DynamoDBAdaptor(client, fixture.tableName).cohortDAO.remove(cohort.id);
    await paused;
    let replacement;
    try {
      await fixture.adaptor.cohortDAO.remove(cohort.id);
      replacement = await fixture.adaptor.cohortDAO.create({
        ...experimentInput().cohorts[0]!,
        experiment_id: experiment.id,
      });
    } finally {
      resume();
    }
    await cleanup;
    expect((await fixture.adaptor.cohortDAO.findBySlug(cohort.slug))?.id).toEqual(replacement?.id);
  });
  it("rejects finalizing a deleted cohort even after its slug is reused", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const oldWinner = experiment.cohorts[0]!;
    await fixture.adaptor.cohortDAO.remove(oldWinner.id);
    const replacement = await fixture.adaptor.cohortDAO.create({
      ...experimentInput().cohorts[0]!,
      experiment_id: experiment.id,
    });
    await expect(
      fixture.adaptor.experimentDAO.update(experiment.id, { winner: oldWinner.slug }, oldWinner.id),
    ).rejects.toThrow("Winning cohort no longer exists");
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
