export class RolloutConflictError extends Error {
  override name = "RolloutConflictError";
  readonly httpStatus = 409;
  constructor(message = "The experiment changed. Refresh its definition and review the change.") {
    super(message);
  }
}
