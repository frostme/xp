import type { ExperimentDefinition } from "~/entities/rollout";
import type { IExperimentDAO } from "~/interfaces";

import { ManagementForbiddenError } from "~/errors/managementForbiddenError";

export interface ManagedDefinitionInput {
  slug: string;
  cohorts: readonly string[];
}

export function createExperimentManagement(
  experiments: IExperimentDAO,
  allowCreate: boolean,
  definition: (input: ManagedDefinitionInput) => ExperimentDefinition,
) {
  return {
    allowCreate,
    async create(input: ManagedDefinitionInput) {
      if (!allowCreate)
        throw new ManagementForbiddenError("Experiment creation is disabled in xp.config.json.");
      return experiments.create(definition(input));
    },
  };
}
