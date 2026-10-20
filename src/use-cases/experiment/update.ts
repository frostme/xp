import type { IUseCase, IValidator, IExperimentDAO } from "~/interfaces";

import { Experiment, type PKey } from "~/entities";
import { ValidationError } from "~/errors";

export default class UpdateExperiment implements IUseCase<void> {
  constructor(
    protected validator: IValidator<Partial<Pick<Experiment, "name" | "description">>>,
    protected experimentDAO: IExperimentDAO,
  ) {}

  async call(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description">>,
  ): Promise<void> {
    const { value, errors } = this.validator.validate(updates);
    if (errors && errors.length > 0) {
      throw new ValidationError("The data is invalid", errors);
    }

    await this.experimentDAO.update(id, value);
  }
}
