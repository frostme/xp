import type { Cohort } from "~/entities";

/** Use a stable order across databases, which return cohort rows in different orders. */
export function weightedCohort(cohorts: readonly Cohort[], random: () => number) {
  const draw = random();
  if (!(draw >= 0 && draw < 1))
    throw new RangeError("Random source must return a number in [0, 1).");
  const ordered = [...cohorts].sort((a, b) => {
    if (a.type !== b.type) return a.type === "control" ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  let end = 0;
  for (const cohort of ordered) {
    end += Math.round(cohort.percentage * 100);
    // Compare in the draw's domain: multiplying 0.0003 by 10,000 rounds below 3.
    if (draw < end / 10_000) return cohort;
  }
  throw new Error("The saved allocation does not cover the full rollout.");
}
