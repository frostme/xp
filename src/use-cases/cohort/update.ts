import type { IUseCase, IValidator, ICohortDAO } from "~/interfaces";

import { Cohort, type PKey } from "~/entities";
import { ValidationError } from "~/errors";

export default class UpdateCohort implements IUseCase<void> {
  constructor(
    protected validator: IValidator<Partial<Pick<Cohort, "description" | "percentage">>>,
    protected cohortDAO: ICohortDAO,
  ) {}

  async call(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void> {
    const { value, errors } = this.validator.validate(updates);
    if (errors && errors.length > 0) {
      throw new ValidationError("The data is invalid", errors);
    }

    await this.cohortDAO.update(id, value);
  }
}
