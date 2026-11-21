import type { PKey } from "~/entities";
import type { IUseCase, IExperimentDAO, ICohortDAO } from "~/interfaces";

import { applyRollout } from "./rollout";

export default class FinalizeExperiment implements IUseCase<void> {
  constructor(
    protected experimentDAO: IExperimentDAO,
    protected cohortDAO: ICohortDAO,
  ) {}

  async call(experimentId: PKey<"Experiment">, cohortId: PKey<"Cohort">): Promise<void> {
    const experiment = await this.experimentDAO.getById(experimentId);
    const cohort = await this.cohortDAO.getById(cohortId);

    if (cohort.experiment_id !== experiment.id) {
      throw new Error("Cohort does not belong to the experiment");
    }

    if (experiment.rolloutPhase) {
      return applyRollout(
        this.experimentDAO,
        experiment.slug,
        experiment.revision!,
        { type: "finalize", cohort: cohort.slug },
        experiment.id,
      );
    }
    await this.experimentDAO.update(experimentId, { winner: cohort.slug }, cohort.id);
  }
}
