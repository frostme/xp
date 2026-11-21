import type { ExperimentSlug } from "~/entities";
import type { ExperimentDefinition } from "~/entities/rollout";
import type { IExperimentDAO } from "~/interfaces";
import type { ExperimentManagement, ManagedDefinitionInput } from "~/interfaces/management";

import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";
import { ManagementForbiddenError } from "~/errors/managementForbiddenError";

import { validateExperimentSlug } from "../user/validateExperimentSlug";
import { availableActions, applyRollout } from "./rollout";

export function createExperimentManagement(
  experiments: IExperimentDAO,
  allowCreate: boolean,
  definition: (input: ManagedDefinitionInput) => ExperimentDefinition,
): ExperimentManagement {
  return {
    allowCreate,
    list(query) {
      return experiments.listPage(query);
    },
    async detail(slug, access) {
      const experiment = await experiments.findBySlug(
        validateExperimentSlug(slug) as ExperimentSlug,
      );
      if (!experiment) throw new ExperimentNotFoundError(slug);
      // A failed read leaves the definition inspectable and every count explicitly unknown.
      const counts = await experiments.countMemberships(experiment).catch(() => null);
      return {
        id: experiment.id,
        slug: experiment.slug,
        name: experiment.name,
        type: experiment.type,
        description: experiment.description,
        enabled: experiment.enabled,
        winner: experiment.winner,
        ...(experiment.rolloutPhase ? { rolloutPhase: experiment.rolloutPhase } : {}),
        revision: experiment.revision ?? 0,
        actions: access === "manage" ? availableActions(experiment) : [],
        countsReadAt: counts ? new Date().toISOString() : null,
        cohorts: experiment.cohorts
          .map((cohort) => ({
            slug: cohort.slug,
            description: cohort.description,
            type: cohort.type,
            value: cohort.value,
            percentage: experiment.rolloutPhase ? cohort.percentage : null,
            memberships: counts?.[cohort.slug] ?? null,
          }))
          .sort((a, b) =>
            a.type === b.type ? a.slug.localeCompare(b.slug) : a.type === "control" ? -1 : 1,
          ),
      };
    },
    apply(slug, revision, command, expectedId) {
      return applyRollout(experiments, slug, revision, command, expectedId);
    },
    async create(input) {
      if (!allowCreate)
        throw new ManagementForbiddenError("Experiment creation is disabled in xp.config.json.");
      return experiments.create(definition(input));
    },
  };
}
