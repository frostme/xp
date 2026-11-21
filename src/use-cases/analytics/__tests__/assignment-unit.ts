import { describe, expect, it, vi } from "vitest";

import type { PendingDelivery } from "~/entities/analytics";

import { DuplicateAssignmentError } from "~/errors";
import GetGroup from "~/use-cases/user/getGroup";
import JoinCohort from "~/use-cases/user/joinCohort";

import { JoinCapture } from "../capture";

function fixture() {
  const experiment = {
    id: 1,
    enabled: true,
    winner: null as string | null,
    type: "flag",
    slug: "cta",
  };
  const cohort = { id: 2, slug: "cta_off", experiment_id: 1 };
  let member: { cohort_id: number } | null = null;
  const outbox: PendingDelivery[] = [];
  const users = {
    findById: async (id: number) => (id === 0 ? { id } : null),
    findUserCohort: async () => member,
    addUserCohort: async (
      _user: number,
      _experiment: number,
      cohort_id: number,
      deliveries: PendingDelivery[],
    ) => {
      if (member) throw new DuplicateAssignmentError();
      member = { cohort_id };
      outbox.push(...deliveries);
      return member;
    },
  };
  const experiments = { findBySlug: async () => experiment };
  const cohorts = {
    getByExperimentId: async () => [cohort],
    getById: async () => cohort,
    findBySlug: async () => cohort,
  };
  const mapIdentity = vi.fn(() => "external");
  const capture = new JoinCapture({
    destinations: [{ key: "sink", provider: "custom:sink" }],
    mapIdentity,
  });
  const group = new GetGroup(
    users as never,
    experiments as never,
    cohorts as never,
    async () => cohort.id as never,
    capture,
  );
  const manual = new JoinCohort(users as never, experiments as never, cohorts as never, capture);
  return {
    experiment,
    outbox,
    mapIdentity,
    decide: (id: number | null = 0) => group.resolveCohort(id, "cta"),
    join: () => manual.call(0 as never, "cta" as never, "cta_off" as never),
  };
}

describe("analytics at the assignment boundary", () => {
  it("commits one staged occurrence for competing off assignments and discards the loser", async () => {
    const { decide, outbox, mapIdentity } = fixture();
    expect(await Promise.all([decide(), decide()])).toEqual([{ slug: null }, { slug: null }]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toMatchObject({ source: "automatic", cohortSlug: "cta_off" });
    const calls = mapIdentity.mock.calls.length;
    await decide();
    expect(mapIdentity).toHaveBeenCalledTimes(calls);
  });
  it("only the stored winner of a mixed manual and automatic race publishes", async () => {
    const { decide, join, outbox } = fixture();
    const [manual, auto] = await Promise.allSettled([join(), decide()]);
    expect(auto).toMatchObject({ status: "fulfilled", value: { slug: null } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event.source).toBe(manual.status === "fulfilled" ? "manual" : "automatic");
    if (manual.status === "rejected")
      expect(manual.reason).toBeInstanceOf(DuplicateAssignmentError);
  });
  it("skips guests, missing users, paused and pinned decisions, and captures an explicit pinned join", async () => {
    const { experiment, decide, join, outbox, mapIdentity } = fixture();
    await decide(null);
    await decide(7);
    experiment.enabled = false;
    await decide();
    experiment.enabled = true;
    experiment.winner = "cta_off";
    await decide();
    expect(mapIdentity).not.toHaveBeenCalled();
    await join();
    await expect(join()).rejects.toBeInstanceOf(DuplicateAssignmentError);
    expect(outbox.map((record) => record.event.source)).toEqual(["manual"]);
  });
});
