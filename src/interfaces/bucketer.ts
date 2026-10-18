import type { PKey } from "~/entities";
export default interface IBucketer {
  (
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
    cohortIds: PKey<"Cohort">[],
  ): Promise<PKey<"Cohort">>;
}
