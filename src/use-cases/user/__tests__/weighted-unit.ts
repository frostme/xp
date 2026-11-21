import { describe, expect, it } from "vitest";

import type { Cohort } from "~/entities";

import type { Allocation } from "../../experiment/rollout";

import { allocationWeights } from "../../experiment/rollout";
import { weightedCohort } from "../weightedCohort";

const cohorts = [
  { id: 3, slug: "checkout_short", percentage: 5.01, type: "treatment" },
  { id: 1, slug: "checkout_off", percentage: 90, type: "control" },
  { id: 2, slug: "checkout_detailed", percentage: 4.99, type: "treatment" },
] as Cohort[];
const split = cohorts.map(({ slug: cohort, percentage }) => ({ cohort, percentage }));

describe("operator allocation", () => {
  it.each([
    [0, 1],
    [8999, 1],
    [9000, 2],
    [9498, 2],
    [9499, 3],
    [9999, 3],
  ])("assigns basis point %i to cohort %i", (draw, id) => {
    expect(weightedCohort(cohorts, () => draw / 10000).id).toBe(id);
  });
  it("places the exact 0.03% boundary in the next cohort", () => {
    const allocation = [
      { ...cohorts[1]!, percentage: 0.03 },
      { ...cohorts[0]!, percentage: 99.97 },
    ];
    expect(weightedCohort(allocation, () => 0.0002999999999999999).id).toBe(1);
    expect(weightedCohort(allocation, () => 0.0003).id).toBe(3);
  });
  it("allocates the entire range to one treatment without sampling zero weight rows", () => {
    const chosen = cohorts.map((row) => ({ ...row, percentage: row.id === 2 ? 100 : 0 }));
    for (const draw of [0, 0.5, 0.999999]) expect(weightedCohort(chosen, () => draw).id).toBe(2);
  });
  it("normalizes fractional percentages and validates every row before writing", () => {
    expect(allocationWeights(cohorts, split).map((row) => row.basisPoints)).toEqual([
      501, 9000, 499,
    ]);
    const invalid: Allocation[][] = [
      [],
      split.slice(1),
      [split[0]!, split[0]!, split[2]!],
      [{ cohort: "other", percentage: 5.01 }, ...split.slice(1)],
      ...[0, NaN, Infinity, -1, 100.1, 5.001].map((percentage) => [
        { ...split[0]!, percentage },
        ...split.slice(1),
      ]),
    ];
    for (const bad of invalid) expect(() => allocationWeights(cohorts, bad)).toThrow();
  });
});
