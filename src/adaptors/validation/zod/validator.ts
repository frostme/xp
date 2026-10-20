import type { PartialDeep } from "type-fest";

import * as z from "zod";

import type { IValidator, IValidatorResult } from "~/interfaces";

export default class ZodValidator<T> implements IValidator<T> {
  constructor(protected schema: z.ZodType<T>) {}

  public validate(data: PartialDeep<T, { recurseIntoArrays: true }>): IValidatorResult<T> {
    const result = this.schema.safeParse(data);
    if (result.success) {
      return { value: result.data };
    }

    return { value: data as T, errors: [z.prettifyError(result.error)] };
  }
}
