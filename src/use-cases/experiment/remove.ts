import type { PKey } from "~/entities";
import type { IUseCase, IExperimentDAO } from "~/interfaces";

export default class RemoveExperiment implements IUseCase<void> {
  constructor(protected experimentDAO: IExperimentDAO) {}

  async call(id: PKey<"Experiment">): Promise<void> {
    await this.experimentDAO.remove(id);
  }
}
