import type { Experiment, ExperimentSlug, CohortSlug, PKey } from "~/entities";
import type { IUseCase, IUserDAO, IExperimentDAO, ICohortDAO, IBucketer } from "~/interfaces";
import type { CohortDecision, UserIdentity } from "~/interfaces/runtime";

import { normalizeIdentity } from "~/entities/identity";
import { DuplicateAssignmentError, ExperimentPausedError, NotFoundError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { validateExperimentSlug } from "./validateExperimentSlug";

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

    return this.assign(userId, await this.experiment(experimentSlug));
  }

  async resolveCohort(identity: UserIdentity, slug: string): Promise<CohortDecision> {
    const experimentSlug = validateExperimentSlug(slug) as ExperimentSlug;
    const userId = normalizeIdentity(identity) as PKey<"User"> | null;
    if (userId === null) return { slug: null };
    try {
      if (!(await this.userDAO.findById(userId))) return { slug: null };
    } catch (error) {
      if (error instanceof NotFoundError) return { slug: null };
      throw error;
    }
    const experiment = await this.experiment(experimentSlug);
    const assigned = await this.assign(userId, experiment);
    const isOff = experiment.type === "flag" && assigned === `${experiment.slug}_off`;
    return { slug: isOff ? null : assigned };
  }

  private async experiment(slug: ExperimentSlug): Promise<Experiment> {
    const experiment = await this.experimentDAO.findBySlug(slug);
    if (!experiment) throw new ExperimentNotFoundError(slug);
    return experiment;
  }

  private async assign(userId: PKey<"User">, experiment: Experiment): Promise<CohortSlug | null> {
    if (!experiment.enabled) return null;

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
      throw new NotFoundError(`No cohorts found for experiment with slug ${experiment.slug}`);
    }

    const cohortId = await this.bucketer(
      userId,
      experiment.id,
      cohorts.map((c) => c.id),
    );
    const cohort = cohorts.find((c) => c.id === cohortId);

    if (cohort) {
      try {
        await this.userDAO.addUserCohort(userId, experiment.id, cohort.id);
      } catch (error) {
        if (error instanceof ExperimentPausedError) return null;
        if (!(error instanceof DuplicateAssignmentError)) throw error;
        const persisted = await this.userDAO.findUserCohort(userId, experiment.id);
        if (!persisted) throw error;
        return (await this.cohortDAO.getById(persisted.cohort_id)).slug;
      }
      return cohort.slug;
    }

    return null;
  }
}
