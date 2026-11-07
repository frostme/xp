import { expect, test, vi } from "vitest";

import type { PKey } from "~/entities";

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
    read: (work) => work(session),
    transaction: (work) => work(session),
  });
  await adaptor.cohortDAO.remove(1 as PKey<"Cohort">);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT/);
});
