import type { PendingDelivery } from "~/entities/analytics";

import { User, UserCohort, type PKey } from "~/entities";

export default interface IUserDAO {
  findById(id: PKey<"User">): Promise<User>;
  findUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
  ): Promise<UserCohort | null>;
  addUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
    cohortId: PKey<"Cohort">,
    deliveries?: readonly PendingDelivery[],
  ): Promise<UserCohort>;
  removeUserCohort(userId: PKey<"User">, experimentId: PKey<"Experiment">): Promise<void>;
}
