import type { Promisable, UnknownRecord } from "type-fest";

import type { Cohort, Experiment } from "~/entities";
import type { IUseCase } from "~/interfaces";

export default class CliFramework {
  constructor(
    protected joinCohortUseCase: IUseCase<void>,
    protected createExperimentUseCase: IUseCase<Experiment>,
    protected finalizeExperimentUseCase: IUseCase<void>,
    protected viewCohortUseCase: IUseCase<Cohort>,
  ) {}

  joinCohort<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
    cohortSlug: Slug,
  ): Promisable<void> {
    return this.joinCohortUseCase.call({ userId, experimentSlug, cohortSlug });
  }

  createExperiment(experimentData: UnknownRecord): Promisable<Experiment> {
    return this.createExperimentUseCase.call(experimentData);
  }

  finalizeExperiment<ID extends string | number>(experimentId: ID, cohortId: ID): Promisable<void> {
    return this.finalizeExperimentUseCase.call({ experimentId, cohortId });
  }

  viewCohort<ID extends string | number>(cohortId: ID): Promisable<Cohort> {
    return this.viewCohortUseCase.call(cohortId);
  }
}
