import type { IError } from "../interfaces";

export class ValidationError extends Error implements IError {
  public override name = "ValidationError";
  public httpStatus = 422;

  constructor(
    public override message: string = "Provided data is invalid",
    public details: { field: string; message: string }[] | string[] = [],
  ) {
    super(message, { cause: details });
  }
}
