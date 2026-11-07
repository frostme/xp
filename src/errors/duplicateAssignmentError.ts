export class DuplicateAssignmentError extends Error {
  override name = "DuplicateAssignmentError";

  constructor(options?: ErrorOptions) {
    super("User is already assigned to a cohort for this experiment", options);
  }
}
