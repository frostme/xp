import type { UserCohort, ExperimentSlug, CohortSlug, PKey } from "~/entities";
import type { IUseCase, IUserDAO, IExperimentDAO, ICohortDAO } from "~/interfaces";
import type { JoinCapture } from "~/use-cases/analytics/capture";

import { DuplicateAssignmentError, ExperimentPausedError, NotFoundError } from "~/errors";

export default class JoinCohort implements IUseCase<UserCohort> {
  constructor(
    protected userDAO: IUserDAO,
    protected experimentDAO: IExperimentDAO,
    protected cohortDAO: ICohortDAO,
    protected capture?: Pick<JoinCapture, "prepare">,
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

    if (!experiment.enabled) throw new ExperimentPausedError();

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
      throw new DuplicateAssignmentError();
    }

    const deliveries = await this.capture?.prepare(userId, {
      experimentSlug: experiment.slug,
      cohortSlug: cohort.slug,
      source: "manual",
    });
    return this.userDAO.addUserCohort(userId, experiment.id, cohort.id, deliveries);
  }
}
