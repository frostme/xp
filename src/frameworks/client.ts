import type { Promisable } from "type-fest";

import type { CohortSlug } from "~/entities";
import type { IUseCase } from "~/interfaces";
export default class ClientFramework {
  constructor(
    protected getUserCohortUseCase: IUseCase<CohortSlug>,
    protected joinCohortUseCase: IUseCase<void>,
    protected leaveExperimentUseCase: IUseCase<void>,
  ) {}

  getUserCohort<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
  ): Promisable<CohortSlug | null> {
    return this.getUserCohortUseCase.call({ userId, experimentSlug });
  }

  joinCohort<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
    cohortSlug: Slug,
  ): Promisable<void> {
    return this.joinCohortUseCase.call({ userId, experimentSlug, cohortSlug });
  }

  leaveExperiment<ID extends string | number, Slug extends string>(
    userId: ID,
    experimentSlug: Slug,
  ): Promisable<void> {
    return this.leaveExperimentUseCase.call({ userId, experimentSlug });
  }
}
