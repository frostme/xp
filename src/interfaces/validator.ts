import type { PartialDeep } from "type-fest";

export interface IValidatorResult<T> {
  errors?: string[];
  value: T;
}

export default interface IValidator<T> {
  validate(body: PartialDeep<T, { recurseIntoArrays: true }>): IValidatorResult<T>;
}
