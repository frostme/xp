import type { UserCohort, ExperimentSlug, CohortSlug, PKey } from "~/entities";
import type { IUseCase, IUserDAO, IExperimentDAO, ICohortDAO } from "~/interfaces";

import { NotFoundError } from "~/errors";

export default class JoinCohort implements IUseCase<UserCohort> {
  constructor(
    protected userDAO: IUserDAO,
    protected experimentDAO: IExperimentDAO,
    protected cohortDAO: ICohortDAO,
  ) {}

  async call(
    userId: PKey<"User">,
    experimentSlug: ExperimentSlug,
    cohortSlug: CohortSlug,
  ): Promise<UserCohort> {
    const experiment = await this.experimentDAO.findBySlug(experimentSlug);
    if (!experiment) {
      throw new NotFoundError(`Experiment with slug ${experimentSlug} not found`);
    }

    const cohort = await this.cohortDAO.findBySlug(cohortSlug);
    if (!cohort) {
      throw new NotFoundError(`Cohort with slug ${cohortSlug} not found`);
    }

    const { experiment_id } = await this.cohortDAO.getById(cohort.id);

    if (experiment_id !== experiment.id) {
      throw new Error(`Cohort ${cohortSlug} does not belong to experiment ${experimentSlug}`);
    }

    const existingUserCohort = await this.userDAO.findUserCohort(userId, experiment.id);
    if (existingUserCohort) {
      throw new Error(`User ${userId} is already in a cohort for experiment ${experimentSlug}`);
    }

    const userCohort = await this.userDAO.addUserCohort(userId, experiment.id, cohort.id);
    return userCohort;
  }
}
