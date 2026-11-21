import type { Cohort, Experiment, ExperimentSlug } from "~/entities";
import type { RolloutChange } from "~/entities/rollout";
import type { IExperimentDAO } from "~/interfaces";

import { ValidationError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import { validateExperimentSlug } from "../user/validateExperimentSlug";

export type Allocation = { cohort: string; percentage: number };
export type RolloutCommand =
  | { type: "launch" | "adjust"; allocation: readonly Allocation[] }
  | { type: "pause" | "resume" }
  | { type: "finalize"; cohort: string };

function invalid(field: string, message: string): never {
  throw new ValidationError(message, [{ field, message }]);
}

export function allocationWeights(cohorts: readonly Cohort[], allocation: readonly Allocation[]) {
  if (!Array.isArray(allocation) || allocation.length !== cohorts.length)
    invalid("allocation", "Include each cohort exactly once.");
  const entries = new Map<string, number>();
  for (const [index, item] of allocation.entries()) {
    if (!item || typeof item.cohort !== "string" || entries.has(item.cohort))
      invalid(`allocation[${index}].cohort`, "Provide a distinct cohort slug.");
    const value = item.percentage;
    const basisPoints = Math.round(value * 100);
    if (!Number.isFinite(value) || value < 0 || value > 100 || basisPoints / 100 !== value)
      invalid(`allocation[${index}].percentage`, "Enter 0–100 with up to two decimal places.");
    entries.set(item.cohort, basisPoints);
  }
  const weights = cohorts.map(({ id, slug }) => {
    const basisPoints = entries.get(slug);
    if (basisPoints === undefined) invalid("allocation", `Missing cohort ${slug}.`);
    return { id, basisPoints };
  });
  if (weights.reduce((sum, row) => sum + row.basisPoints, 0) !== 10000)
    invalid("allocation", "The allocation must total 100%.");
  return weights;
}

export function availableActions(
  experiment: Pick<Experiment, "enabled" | "rolloutPhase" | "winner">,
): RolloutCommand["type"][] {
  if (!experiment.enabled) return ["resume"];
  if (experiment.rolloutPhase === "awaiting-launch") return ["launch", "pause"];
  if (experiment.rolloutPhase === "allocating") return ["adjust", "pause", "finalize"];
  return experiment.winner ? ["pause"] : ["pause", "finalize"];
}

function changeFor(experiment: Experiment, command: RolloutCommand): RolloutChange | null {
  const change: RolloutChange = {
    id: experiment.id,
    expectedRevision: experiment.revision ?? 0,
    enabled: experiment.enabled,
    phase: experiment.rolloutPhase ?? null,
    winner: experiment.winner,
  };
  switch (command.type) {
    case "pause":
    case "resume":
      change.enabled = command.type === "resume";
      if (experiment.enabled === change.enabled) return null;
      break;
    case "finalize": {
      const winner = experiment.cohorts.find((row) => row.slug === command.cohort);
      if (!winner) invalid("cohort", "Choose a cohort that belongs to this experiment.");
      if (
        experiment.enabled &&
        experiment.rolloutPhase !== "awaiting-launch" &&
        experiment.winner === winner.slug
      )
        return null;
      change.winner = winner.slug;
      if (experiment.rolloutPhase) change.phase = "winner-selected";
      break;
    }
    case "launch":
    case "adjust":
      change.weights = allocationWeights(experiment.cohorts, command.allocation);
      change.phase = "allocating";
      change.winner = null;
      if (
        experiment.enabled &&
        experiment.rolloutPhase === "allocating" &&
        change.weights.every(
          (row, i) => row.basisPoints / 100 === experiment.cohorts[i]!.percentage,
        )
      )
        return null;
      break;
    default:
      return invalid("type", "Unknown management command.");
  }
  if (!availableActions(experiment).includes(command.type))
    throw new RolloutConflictError(
      "This action is unavailable in the current phase. Refresh the experiment.",
    );
  return change;
}

export async function applyRollout(
  experiments: IExperimentDAO,
  slug: string,
  expectedRevision: number,
  command: RolloutCommand,
  expectedId?: Experiment["id"],
): Promise<void> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    invalid("revision", "Supply the saved experiment revision.");
  const experiment = await experiments.findBySlug(validateExperimentSlug(slug) as ExperimentSlug);
  if (!experiment) throw new ExperimentNotFoundError(slug);
  if (expectedId !== undefined && experiment.id !== expectedId) throw new RolloutConflictError();
  const change = changeFor(experiment, command);
  const revision = experiment.revision ?? 0;
  // Retrying an already-applied desired state succeeds without creating a new revision.
  if (change === null && expectedRevision <= revision) return;
  if (!change || expectedRevision !== revision) throw new RolloutConflictError();
  await experiments.commitRollout(change);
}
