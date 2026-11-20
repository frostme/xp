import { isSlugPart } from "~/entities/slug";

import type { AssignmentSnapshot } from "./session";

interface Gate {
  experiment: string;
  qualified: string | null;
}

export function parseGate(
  enclosing: string | undefined,
  slug: string | undefined,
  isDefault = false,
): Gate {
  if (enclosing !== undefined && !isSlugPart(enclosing))
    throw new TypeError("Invalid enclosing experiment slug");
  if (isDefault) {
    if (!enclosing || slug !== undefined)
      throw new Error("A default Cohort requires an enclosing Experiment and no slug");
    return { experiment: enclosing, qualified: null };
  }
  if (typeof slug === "string" && slug.includes("_")) {
    const [experiment, local, extra] = slug.split("_");
    if (!isSlugPart(experiment) || !isSlugPart(local) || extra !== undefined)
      throw new Error("Invalid qualified cohort slug");
    if (enclosing && enclosing !== experiment)
      throw new Error("Cohort slug conflicts with its enclosing Experiment");
    return { experiment, qualified: slug };
  }
  if (!enclosing || !isSlugPart(slug))
    throw new Error("A local cohort slug requires an enclosing Experiment");
  return { experiment: enclosing, qualified: enclosing + "_" + slug };
}

export function matchesGate(gate: Gate, snapshot: AssignmentSnapshot) {
  return snapshot.status === "ready"
    ? snapshot.slug === gate.qualified
    : snapshot.status === "error" && gate.qualified === null;
}
