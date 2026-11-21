import { expect, test, vi } from "vitest";

import type { PKey } from "~/entities";

import { Cohort, Experiment } from "~/entities";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import { relationalAdaptor, type SqlSession } from "../../relational";

test("a stale cohort removal cannot clear a replacement cohort's winner", async () => {
  const query = vi.fn().mockResolvedValue([{ id: 1, experiment_id: 10, slug: "test_control" }]);
  const session: SqlSession = {
    query,
    insert: vi.fn(),
    parameter: (index) => `$${index}`,
    lock: vi
      .fn()
      .mockResolvedValueOnce([{ id: 10, winner: "test_control" }])
      .mockResolvedValueOnce([]),
  };
  const adaptor = relationalAdaptor({
    dialect: "postgres",
    read: (work) => work(session),
    transaction: (work) => work(session),
  });
  await adaptor.cohortDAO.remove(1 as PKey<"Cohort">);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT/);
});

test("counts cannot report a replacement cohort's memberships on an old definition", async () => {
  const slug = "test_control" as Cohort["slug"];
  const experiment = Object.assign(new Experiment(), {
    id: 10 as PKey<"Experiment">,
    cohorts: [Object.assign(new Cohort(), { id: 1 as PKey<"Cohort">, slug })],
  });
  const query = vi.fn().mockResolvedValue([{ id: 2, slug, members: "9" }]);
  const session: SqlSession = {
    query,
    insert: vi.fn(),
    lock: vi.fn(),
    parameter: (index) => `$${index}`,
  };
  const { experimentDAO } = relationalAdaptor({
    dialect: "postgres",
    read: (work) => work(session),
    transaction: vi.fn(),
  });
  await expect(experimentDAO.countMemberships(experiment)).rejects.toBeInstanceOf(
    RolloutConflictError,
  );
  expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("GROUP BY"), [10]);
});
