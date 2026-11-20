export class ExperimentPausedError extends Error {
  override name = "ExperimentPausedError";

  constructor(options?: ErrorOptions) {
    super("Experiment is paused", options);
  }
}
