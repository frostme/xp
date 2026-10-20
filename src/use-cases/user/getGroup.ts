import type { IUseCase, IUserDAO, IExperimentDAO, ICohortDAO, IBucketer } from "~/interfaces";

import { type ExperimentSlug, type CohortSlug, type PKey } from "~/entities";
import { NotFoundError } from "~/errors";

type UseCaseParams = {
  userId: PKey<"User">;
  experimentSlug: ExperimentSlug;
};

export default class GetGroup implements IUseCase<CohortSlug | null> {
  constructor(
    protected userDAO: IUserDAO,
    protected experimentDAO: IExperimentDAO,
    protected cohortDAO: ICohortDAO,
    protected bucketer: IBucketer,
  ) {}

  async call(payload: UseCaseParams): Promise<CohortSlug | null> {
    const { userId, experimentSlug } = payload;

    const user = await this.userDAO.findById(userId);
    if (!user) {
      throw new NotFoundError(`User with id ${userId} not found`);
    }

    const experiment = await this.experimentDAO.findBySlug(experimentSlug);

    if (!experiment) {
      throw new NotFoundError(`Experiment with slug ${experimentSlug} not found`);
    }

    if (experiment.winner) {
      return experiment.winner;
    }

    const userCohort = await this.userDAO.findUserCohort(userId, experiment.id);

    if (userCohort) {
      const cohort = await this.cohortDAO.getById(userCohort.cohort_id);
      return cohort.slug;
    }

    const cohorts = await this.cohortDAO.getByExperimentId(experiment.id);

    if (cohorts.length === 0) {
      throw new NotFoundError(`No cohorts found for experiment with slug ${experimentSlug}`);
    }

    const cohortId = await this.bucketer(
      userId,
      experiment.id,
      cohorts.map((c) => c.id),
    );
    const cohort = cohorts.find((c) => c.id === cohortId);

    if (cohort) {
      await this.userDAO.addUserCohort(userId, experiment.id, cohort.id);
      return cohort.slug;
    }

    return null;
  }
}
