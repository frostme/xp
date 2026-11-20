import type { CohortDecision, CohortRuntime } from "~/interfaces/runtime";

import { ValidationError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { readIdentity, validateExperimentSlug, type IdentityOptions } from "./request";

export interface RestDecisionOptions<Host> extends IdentityOptions<Host> {
  runtime: CohortRuntime;
  resolveBody?: (result: CohortDecision) => unknown;
}

export async function resolveRestDecision<Host>(
  request: Host,
  body: unknown,
  options: RestDecisionOptions<Host>,
  readHeader: (name: string) => unknown,
  readDefault: () => unknown,
): Promise<{ status: 200; body: unknown } | { status: 400 | 404; body: { error: string } }> {
  let slug: string;
  try {
    slug = validateExperimentSlug(
      typeof body === "object" && body !== null && "slug" in body ? body.slug : undefined,
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { status: 400, body: { error: "Invalid experiment slug" } };
  }

  const id = await readIdentity(request, options, readHeader, readDefault);
  let result: CohortDecision;
  try {
    result = await options.runtime.resolveCohort(id, slug);
  } catch (error) {
    if (!(error instanceof ExperimentNotFoundError)) throw error;
    return { status: 404, body: { error: "Experiment not found" } };
  }
  return { status: 200, body: options.resolveBody ? await options.resolveBody(result) : result };
}
