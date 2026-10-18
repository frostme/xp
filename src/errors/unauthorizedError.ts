import type { IError } from "../interfaces";

export class UnauthorizedError extends Error implements IError {
  public override name = "UnauthorizedError";
  public httpStatus = 401;

  constructor(
    public override message: string = "Unautorized",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
