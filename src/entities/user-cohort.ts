import type { PKey } from "./types";

import Entity from "./entity";

export default class UserCohort extends Entity<UserCohort, "UserCohort"> {
  experiment_id!: PKey<"Experiment">;
  user_id!: PKey<"User">;
  cohort_id!: PKey<"Cohort">;
}
