import type { UnknownRecord } from "type-fest";

import type { CohortSlug, UserCohort, Cohort, Experiment } from "~/entities";
import type { IUseCase } from "~/interfaces";
export default class ServerFramework {
  constructor(
    protected getGroupUseCase: IUseCase<CohortSlug | null>,
    protected joinCohortUseCase: IUseCase<UserCohort>,
    protected leaveExperimentUseCase: IUseCase<void>,
    protected addCohortUseCase: IUseCase<Cohort>,
    protected createExperimentUseCase: IUseCase<Experiment>,
    protected finalizeExperimentUseCase: IUseCase<void>,
    protected removeExperimentUseCase: IUseCase<void>,
    protected updateExperimentUseCase: IUseCase<void>,
    protected viewCohortUseCase: IUseCase<Cohort>,
    protected updateCohortUseCase: IUseCase<void>,
    protected removeCohortUseCase: IUseCase<void>,
  ) {}

  async getGroup<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
  ): Promise<CohortSlug | null> {
    return this.getGroupUseCase.call({ userId, experimentSlug });
  }

  async joinCohort<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
    cohortSlug: Slug,
  ): Promise<UserCohort> {
    return this.joinCohortUseCase.call(userId, experimentSlug, cohortSlug);
  }

  async leaveExperiment<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
  ): Promise<void> {
    return this.leaveExperimentUseCase.call(userId, experimentSlug);
  }

  async addCohortToExperiment<ID extends string | number>(
    experimentId: ID,
    cohortData: UnknownRecord,
  ): Promise<Cohort> {
    return this.addCohortUseCase.call(experimentId, cohortData);
  }

  async createExperiment(experimentData: UnknownRecord): Promise<Experiment> {
    return this.createExperimentUseCase.call(experimentData);
  }

  async finalizeExperiment<ID extends string | number>(
    experimentId: ID,
    cohortId: ID,
  ): Promise<void> {
    return this.finalizeExperimentUseCase.call(experimentId, cohortId);
  }

  async removeExperiment<ID extends string | number>(experimentId: ID): Promise<void> {
    return this.removeExperimentUseCase.call(experimentId);
  }

  async updateExperiment<ID extends string | number>(
    experimentId: ID,
    experimentData: UnknownRecord,
  ): Promise<void> {
    return this.updateExperimentUseCase.call(experimentId, experimentData);
  }

  async viewCohort<Slug extends string>(cohortSlug: Slug): Promise<Cohort> {
    return this.viewCohortUseCase.call(cohortSlug);
  }

  async updateCohort<ID extends string | number>(
    cohortId: ID,
    cohortData: UnknownRecord,
  ): Promise<void> {
    return this.updateCohortUseCase.call(cohortId, cohortData);
  }

  async removeCohort<ID extends string | number>(cohortId: ID): Promise<void> {
    return this.removeCohortUseCase.call(cohortId);
  }
}
