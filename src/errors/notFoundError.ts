import type { IError } from "../interfaces";

export class NotFoundError extends Error implements IError {
  public override name = "NotFoundError";
  public httpStatus = 404;

  constructor(
    public override message: string = "Record not found",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
