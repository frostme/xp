import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";

import type { PKey } from "~/entities";
import type { AnalyticsDestination, CohortJoinedV1, PendingDelivery } from "~/entities/analytics";
import type { AnalyticsStore } from "~/interfaces/analytics";

import { DuplicateAssignmentError } from "~/errors";
import { claimReference } from "~/use-cases/analytics/delivery";

import { experimentInput, type StorageFixture } from "./contract";

const alpha = { key: "alpha", provider: "amplitude" };
const beta = { key: "beta", provider: "segment" };

function envelope(cohortSlug: string): CohortJoinedV1 {
  return {
    name: "xp.cohort.joined",
    version: 1,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    experimentSlug: "analytics-test",
    cohortSlug,
    source: "manual",
  };
}

function snapshot(event: CohortJoinedV1, dest: AnalyticsDestination): PendingDelivery {
  return {
    event,
    destinationKey: dest.key,
    provider: dest.provider,
    subjectId: dest.key + "-external",
  };
}

async function claim(store: AnalyticsStore, dest: AnalyticsDestination, now: number) {
  // DynamoDB's due-work GSI becomes visible after the transaction commits.
  for (let page = 0; page < 50; page++) {
    const rows = await store.claim(dest, { now, limit: 1, leaseMs: 1000 });
    if (rows.length) return rows[0]!;
    await sleep(25);
  }
  throw new Error("Expected an indexed due delivery");
}

export async function analyticsContract(
  fixture: StorageFixture & { applyAnalytics(): Promise<void> },
) {
  const { adaptor, seedUser } = fixture;
  const store = adaptor.analytics!;
  await expect(store.ready([alpha])).rejects.toThrow();
  await fixture.applyAnalytics();
  await Promise.all([store.ready([alpha, beta]), store.ready([alpha, beta])]);
  await expect(store.ready([{ ...alpha, provider: "mixpanel" }])).rejects.toThrow();
  expect(await store.destinations(null, 1)).toEqual([alpha]);
  expect(await store.destinations(alpha.key, 10)).toEqual([beta]);
  const experiment = await adaptor.experimentDAO.create(experimentInput("analytics-test"));
  const cohort = experiment.cohorts[0]!;
  const user = "analytics-contract-user" as PKey<"User">;
  const second = "analytics-contract-second" as PKey<"User">;
  await seedUser(user);
  await seedUser(second);
  const add = (id: typeof user, rows: PendingDelivery[]) =>
    adaptor.userDAO.addUserCohort(id, experiment.id, cohort.id, rows);
  const left = envelope(cohort.slug),
    right = envelope(cohort.slug);
  const addForBoth = (event: CohortJoinedV1) =>
    add(user, [snapshot(event, alpha), snapshot(event, beta)]);
  const race = await Promise.allSettled([addForBoth(left), addForBoth(right)]);
  expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const loser = race.find((item) => item.status === "rejected");
  expect(loser?.reason).toBeInstanceOf(DuplicateAssignmentError);
  const winner = race[0].status === "fulfilled" ? left : right;
  // The first new delivery and the membership must roll back on the second delivery's key collision.
  const failed = add(second, [snapshot(envelope(cohort.slug), alpha), snapshot(winner, beta)]);
  await expect(failed).rejects.toThrow();
  await expect(failed).rejects.not.toBeInstanceOf(DuplicateAssignmentError);
  expect(await adaptor.userDAO.findUserCohort(second, experiment.id)).toBeNull();
  await add(second, []);
  await adaptor.userDAO.removeUserCohort(user, experiment.id);
  const rejoin = envelope(cohort.slug);
  await add(user, [snapshot(rejoin, alpha)]);
  await adaptor.experimentDAO.remove(experiment.id);

  const now = Date.now() + 100;
  expect(
    await store.claim({ ...alpha, provider: "heap" }, { now, limit: 1, leaseMs: 1000 }),
  ).toEqual([]);
  const first = await claim(store, beta, now);
  expect(first).toMatchObject({ ...snapshot(winner, beta), attempts: 1 });
  const stale = claimReference(first);
  expect(await store.renew(stale, now + 2000, now + 100)).toBe(true);
  expect(await store.claim(beta, { now: now + 1500, limit: 1, leaseMs: 1000 })).toEqual([]);
  const secondClaim = await claim(store, beta, now + 2001);
  expect(secondClaim.leaseToken).not.toBe(first.leaseToken);
  expect(secondClaim.event).toEqual(winner);
  expect(await store.settle(stale, { state: "delivered" }, now + 2002)).toBe(false);
  expect(await store.renew(stale, now + 9000, now + 2002)).toBe(false);
  expect(await store.prune(beta.key, now + 9000, 2)).toBe(0);
  expect(await store.purge(beta.key, now + 2002, 2)).toBe(0);
  expect(
    await store.settle(
      claimReference(secondClaim),
      { state: "failed", reason: "unauthorized" },
      now + 2002,
    ),
  ).toBe(true);
  const summary = await store.inspect(beta.key, "failed", 1);
  expect(summary).toEqual([
    {
      eventId: winner.id,
      provider: beta.provider,
      destinationKey: beta.key,
      occurredAt: winner.occurredAt,
      state: "failed",
      attempts: 2,
      reason: "unauthorized",
    },
  ]);
  expect(await store.redrive(beta.key, winner.id, now + 3000)).toBe(true);
  const replay = await claim(store, beta, now + 3000);
  expect(replay).toMatchObject({ ...snapshot(winner, beta), attempts: 1 });
  expect(
    await store.settle(
      claimReference(replay),
      { state: "pending", availableAt: now + 6000, reason: "network" },
      now + 3001,
    ),
  ).toBe(true);
  expect(await store.claim(beta, { now: now + 5999, limit: 1, leaseMs: 1000 })).toEqual([]);
  const retry = await claim(store, beta, now + 6000);
  expect(await store.settle(claimReference(retry), { state: "delivered" }, now + 6001)).toBe(true);
  expect(await store.prune(beta.key, now + 6001, 1)).toBe(0);
  expect(await store.prune(beta.key, now + 6002, 1)).toBe(1);
  expect(await store.prune(alpha.key, now + 6002, 1)).toBe(0);
  const pending = await store.diagnostics(alpha.key);
  expect(pending.counts).toEqual({ pending: 2, claimed: 0, failed: 0, delivered: 0 });
  expect(pending.oldestPendingAt).toBe(
    Math.min(Date.parse(winner.occurredAt), Date.parse(rejoin.occurredAt)),
  );
  expect(await store.purge(alpha.key, now + 6002, 1)).toBe(1);
  expect(await store.purge(alpha.key, now + 6002, 2)).toBe(1);
}
