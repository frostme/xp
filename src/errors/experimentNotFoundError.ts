import { NotFoundError } from "./notFoundError";

export class ExperimentNotFoundError extends NotFoundError {
  override name = "ExperimentNotFoundError";

  constructor(slug: string) {
    super(`Experiment with slug ${slug} not found`);
  }
}
