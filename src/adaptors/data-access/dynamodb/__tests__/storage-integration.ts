import {
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CohortSlug, PKey } from "~/entities";
import type { PendingDelivery } from "~/entities/analytics";

import { analyticsContract } from "~/__tests__/storage/analyticsContract";
import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";
import { parseManagedDefinition } from "~/adaptors/validation/zod/seed";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

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

  it("captures analytics atomically and fences indexed deliveries", async () => {
    await analyticsContract(fixture);
  });

  it("paginates due queries and gives each row to at most one concurrent worker", async () => {
    await fixture.applyAnalytics();
    const destination = { key: "sink", provider: "custom:test" };
    await fixture.adaptor.analytics!.ready([destination]);
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const cohort = experiment.cohorts[0]!;
    for (let i = 0; i < 4; i++) {
      const user = ("worker-race-" + i) as PKey<"User">;
      await fixture.seedUser(user);
      const delivery: PendingDelivery = {
        event: {
          name: "xp.cohort.joined",
          version: 1,
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          experimentSlug: experiment.slug,
          cohortSlug: cohort.slug,
          source: "manual",
        },
        destinationKey: destination.key,
        provider: destination.provider,
        subjectId: "mapped-" + i,
      };
      await fixture.adaptor.userDAO.addUserCohort(user, experiment.id, cohort.id, [delivery]);
    }

    let continuations = 0;
    const client = {
      send: (command: any) => {
        if (command instanceof ScanCommand) throw new Error("Worker issued a table scan");
        if (command instanceof QueryCommand) {
          expect(command.input.IndexName).toBe("xp_analytics_due");
          if (command.input.ExclusiveStartKey) continuations++;
          return fixture.client.send(new QueryCommand({ ...command.input, Limit: 1 }));
        }
        return fixture.client.send(command);
      },
    } as DynamoDBDocumentClient;
    const store = new DynamoDBAdaptor(client, fixture.tableName).analytics;
    const opts = { now: Date.now() + 100, limit: 4, leaseMs: 60_000 };
    await expect.poll(async () => (await store.inspect("sink", "pending", 4)).length).toBe(4);
    const lists = await Promise.all([
      store.claim(destination, opts),
      store.claim(destination, opts),
    ]);
    const claims = lists.flat();
    expect(continuations).toBeGreaterThan(0);
    expect(claims).toHaveLength(4);
    expect(new Set(claims.map((row) => row.event.id)).size).toBe(4);
    expect(new Set(claims.map((row) => row.leaseToken)).size).toBe(4);
  });
  it("finds an experiment by literal name through sparse physical scan pages", async () => {
    const input = { ...experimentInput("checkout"), name: "Check [A+B]" };
    await fixture.adaptor.experimentDAO.create(input);
    await fixture.adaptor.experimentDAO.create(experimentInput("other"));
    const client = {
      send(command: ScanCommand) {
        expect(command).toBeInstanceOf(ScanCommand);
        return fixture.client.send(new ScanCommand({ ...command.input, Limit: 1 }));
      },
    } as DynamoDBDocumentClient;
    const dao = new DynamoDBAdaptor(client, fixture.tableName).experimentDAO;
    const matches = [];
    let cursor: string | undefined;
    let emptyPages = 0;
    do {
      const page = await dao.listPage({ query: "[a+b]", limit: 1, ...(cursor ? { cursor } : {}) });
      matches.push(...page.items);
      if (page.items.length === 0) emptyPages++;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(emptyPages).toBeGreaterThan(0);
    expect(matches).toEqual([
      { name: input.name, slug: input.slug, type: input.type, enabled: true, winner: null },
    ]);
  });

  it("counts every reverse membership page, retains zero cohorts, and propagates unavailable reads", async () => {
    const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
    const [first, second] = experiment.cohorts;
    const userIds = ["alice", "bob", "carol"] as PKey<"User">[];
    for (const id of userIds) {
      await fixture.seedUser(id);
      await fixture.adaptor.userDAO.addUserCohort(id, experiment.id, first!.id);
    }
    let countQueries = 0;
    let unavailable = false;
    const client = {
      send(command: QueryCommand) {
        expect(command).toBeInstanceOf(QueryCommand);
        expect(command.input).toMatchObject({ Select: "COUNT", ConsistentRead: true });
        if (unavailable) throw new Error("count read failed");
        countQueries++;
        return fixture.client.send(new QueryCommand({ ...command.input, Limit: 1 }));
      },
    } as DynamoDBDocumentClient;
    const dao = new DynamoDBAdaptor(client, fixture.tableName).experimentDAO;
    await expect(dao.countMemberships(experiment)).resolves.toEqual({
      [first!.slug]: 3,
      [second!.slug]: 0,
    });
    expect(countQueries).toBeGreaterThan(3);
    await fixture.adaptor.userDAO.removeUserCohort(userIds[0]!, experiment.id);
    expect((await dao.countMemberships(experiment))[first!.slug]).toBe(2);
    unavailable = true;
    await expect(dao.countMemberships(experiment)).rejects.toThrow("count read failed");
  });

  it("rolls back all 32 weights and the parent when a child write loses its condition", async () => {
    const dao = fixture.adaptor.experimentDAO;
    const names = Array.from({ length: 31 }, (_, i) => `treatment-${i}`);
    const created = await dao.create(
      parseManagedDefinition({ slug: "allocation", cohorts: names }, "dynamodb"),
    );
    const weights = created.cohorts.map((c) => ({
      id: c.id,
      basisPoints: c.slug === "allocation_treatment-0" ? 10000 : 0,
    }));
    const change = {
      id: created.id,
      expectedRevision: 1,
      enabled: true,
      phase: "allocating",
      winner: null,
      weights,
    } as const;
    await expect(
      dao.commitRollout({
        ...change,
        weights: [...weights.slice(0, -1), { id: "missing" as PKey<"Cohort">, basisPoints: 0 }],
      }),
    ).rejects.toBeInstanceOf(RolloutConflictError);
    const pinned = await dao.getById(created.id);
    expect(pinned).toMatchObject({
      revision: 1,
      rolloutPhase: "awaiting-launch",
      winner: "allocation_off",
    });
    expect(pinned.cohorts.find((c) => c.slug === "allocation_off")?.percentage).toBe(100);
    expect(pinned.cohorts.find((c) => c.slug === "allocation_treatment-0")?.percentage).toBe(0);
    await dao.commitRollout(change);
    const launched = await dao.getById(created.id);
    expect(launched).toMatchObject({ revision: 2, rolloutPhase: "allocating", winner: null });
    expect(launched.cohorts.find((c) => c.slug === "allocation_treatment-0")?.percentage).toBe(100);
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
