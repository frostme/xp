import type { PartialDeep } from "type-fest";

export interface IValidatorResult<T> {
  errors?: string[];
  value: T;
}

export interface IValidatorAdaptor {
  cohort: {
    create: IValidator<any>;
    update: IValidator<any>;
  };
  experiment: {
    create: IValidator<any>;
    update: IValidator<any>;
  };
}

export default interface IValidator<T> {
  validate(body: PartialDeep<T, { recurseIntoArrays: true }>): IValidatorResult<T>;
}
