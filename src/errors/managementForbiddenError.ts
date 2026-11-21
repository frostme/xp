export class ManagementForbiddenError extends Error {
  override name = "ManagementForbiddenError";
  readonly httpStatus = 403;
}
