import type { PKey, ExperimentSlug } from "~/entities";
import type { IUseCase, IUserDAO, IExperimentDAO } from "~/interfaces";

import { NotFoundError } from "~/errors";

export default class LeaveExperiment implements IUseCase<void> {
  constructor(
    protected userDAO: IUserDAO,
    protected experimentDAO: IExperimentDAO,
  ) {}

  async call(userId: PKey<"User">, experimentSlug: ExperimentSlug): Promise<void> {
    const experiment = await this.experimentDAO.findBySlug(experimentSlug);
    if (!experiment) {
      throw new NotFoundError(`Experiment with slug ${experimentSlug} not found`);
    }

    const existingUserCohort = await this.userDAO.findUserCohort(userId, experiment.id);
    if (!existingUserCohort) {
      throw new Error(`User ${userId} is not in a cohort for experiment ${experimentSlug}`);
    }

    await this.userDAO.removeUserCohort(userId, experiment.id);
  }
}
