import type { IUseCase, IExperimentDAO, IValidator } from "~/interfaces";

import { Experiment, type CreationPayload } from "~/entities";
import { ValidationError } from "~/errors";

export default class CreateExperiment implements IUseCase<Experiment> {
  constructor(
    protected validator: IValidator<CreationPayload<Experiment>>,
    protected experimentDAO: IExperimentDAO,
  ) {}

  async call(payload: CreationPayload<Experiment>): Promise<Experiment> {
    const { value, errors } = this.validator.validate(payload);
    if (errors && errors.length > 0) {
      throw new ValidationError("The data is invalid", errors);
    }

    const experiment = await this.experimentDAO.create(value);

    return experiment;
  }
}
