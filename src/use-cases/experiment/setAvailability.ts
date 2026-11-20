import type { ExperimentSlug } from "~/entities";
import type { IExperimentDAO, IUseCase } from "~/interfaces";

export default class SetExperimentAvailability implements IUseCase<void> {
  constructor(private readonly experiments: IExperimentDAO) {}

  call(slug: ExperimentSlug, enabled: boolean): Promise<void> {
    return this.experiments.setEnabled(slug, enabled);
  }
}
