import type Experiment from "./experiment";
import type { CreationPayload, CohortSlug } from "./types";

export type RolloutPhase = "awaiting-launch" | "allocating" | "winner-selected";
export type ExperimentDefinition = CreationPayload<Experiment> & { rollout?: "off-first" };

/** The definition and its initial delivery state are inserted in the same transaction. */
export function initialDelivery(input: ExperimentDefinition) {
  if (input.rollout === "off-first") {
    return {
      enabled: true,
      winner: `${input.slug}_off` as CohortSlug,
      rollout_phase: "awaiting-launch" as const,
      rollout_revision: 1,
    };
  }
  return { winner: null };
}

export function rolloutMetadata(phase: unknown, revision: unknown) {
  if (phase == null) return revision ? { revision: Number(revision) } : {};
  if (
    (phase !== "awaiting-launch" && phase !== "allocating" && phase !== "winner-selected") ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1
  )
    throw new Error("Invalid stored rollout state");
  return { rolloutPhase: phase as RolloutPhase, revision: Number(revision) };
}
