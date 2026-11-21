import type { Experiment } from "~/entities";
import type { ExperimentDefinition } from "~/entities/rollout";
import type { IExperimentDAO } from "~/interfaces";

import { ManagementForbiddenError } from "~/errors/managementForbiddenError";

import type { RolloutCommand } from "./rollout";

import { applyRollout } from "./rollout";

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
    apply(slug: string, revision: number, command: RolloutCommand, expectedId?: Experiment["id"]) {
      return applyRollout(experiments, slug, revision, command, expectedId);
    },
    async create(input: ManagedDefinitionInput) {
      if (!allowCreate)
        throw new ManagementForbiddenError("Experiment creation is disabled in xp.config.json.");
      return experiments.create(definition(input));
    },
  };
}
