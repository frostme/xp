import type { Experiment, ExperimentSlug, CohortSlug, PKey } from "~/entities";
import type { IUseCase, IUserDAO, IExperimentDAO, ICohortDAO, IBucketer } from "~/interfaces";
import type { CohortDecision, UserIdentity } from "~/interfaces/runtime";
import type { JoinCapture } from "~/use-cases/analytics/capture";

import { normalizeIdentity } from "~/entities/identity";
import { DuplicateAssignmentError, ExperimentPausedError, NotFoundError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import { validateExperimentSlug } from "./validateExperimentSlug";
import { weightedCohort } from "./weightedCohort";

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
    protected capture?: Pick<JoinCapture, "prepare">,
    private readonly random: () => number = Math.random,
  ) {}

  async call(payload: UseCaseParams): Promise<CohortSlug | null> {
    const { userId, experimentSlug } = payload;

    const user = await this.userDAO.findById(userId);
    if (!user) {
      throw new NotFoundError(`User with id ${userId} not found`);
    }

    return (await this.decision(userId, experimentSlug)).slug;
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
    const decision = await this.decision(userId, experimentSlug);
    const off = decision.experiment.rolloutPhase || decision.experiment.type === "flag";
    return { slug: off && decision.slug === `${experimentSlug}_off` ? null : decision.slug };
  }

  private async decision(userId: PKey<"User">, slug: ExperimentSlug) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const experiment = await this.experiment(slug);
      try {
        return { experiment, slug: await this.assign(userId, experiment) };
      } catch (error) {
        if (!(error instanceof RolloutConflictError) || attempt === 4) throw error;
      }
    }
    throw new RolloutConflictError();
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

    const cohorts = experiment.rolloutPhase
      ? experiment.cohorts
      : await this.cohortDAO.getByExperimentId(experiment.id);

    if (cohorts.length === 0) {
      throw new NotFoundError(`No cohorts found for experiment with slug ${experiment.slug}`);
    }

    const cohortId = experiment.rolloutPhase
      ? weightedCohort(cohorts, this.random).id
      : await this.bucketer(
          userId,
          experiment.id,
          cohorts.map((c) => c.id),
        );
    const cohort = cohorts.find((c) => c.id === cohortId);

    if (cohort) {
      try {
        const deliveries = await this.capture?.prepare(userId, {
          experimentSlug: experiment.slug,
          cohortSlug: cohort.slug,
          source: "automatic",
        });
        await this.userDAO.addUserCohort(
          userId,
          experiment.id,
          cohort.id,
          deliveries,
          experiment.rolloutPhase ? experiment.revision : undefined,
        );
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
