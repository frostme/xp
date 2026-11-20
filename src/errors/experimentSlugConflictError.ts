export class ExperimentSlugConflictError extends Error {
  override name = "ExperimentSlugConflictError";

  constructor(
    readonly slug: string,
    options?: ErrorOptions,
  ) {
    super(`Experiment slug ${slug} is already in use`, options);
  }
}
