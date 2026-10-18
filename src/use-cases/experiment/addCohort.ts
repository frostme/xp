import type { IUseCase, IValidator, IExperimentDAO, ICohortDAO } from "~/interfaces";

import { type PKey, type CreationPayload, Cohort } from "~/entities";
import { ValidationError } from "~/errors";

export default class AddCohortToExperiment implements IUseCase<Cohort> {
  constructor(
    protected validator: IValidator<CreationPayload<Cohort>>,
    protected experimentDAO: IExperimentDAO,
    protected cohortDAO: ICohortDAO,
  ) {}

  async call(
    experimentId: PKey<"Experiment">,
    cohortData: CreationPayload<Cohort>,
  ): Promise<Cohort> {
    const { value, errors } = this.validator.validate(cohortData);
    if (errors && errors.length > 0) {
      throw new ValidationError("The data is invalid", errors);
    }

    const experiment = await this.experimentDAO.getById(experimentId);

    const cohort = await this.cohortDAO.create({
      ...value,
      experiment_id: experiment.id,
    });

    return cohort;
  }
}
