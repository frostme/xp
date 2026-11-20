import { channel } from "node:diagnostics_channel";

import type { CohortRuntime, UserIdentity } from "~/interfaces/runtime";

import { decodeAssignment } from "~/client/loaders/shared";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { validateExperimentSlug } from "../request";

const failures = channel("xp.request.error");

// These gRPC wire status codes are shared by native gRPC and the two gRPC-Web deployments.
export class RpcDecisionError extends Error {
  constructor(
    readonly code: 3 | 5 | 13,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveRpcDecision(
  requestSlug: unknown,
  runtime: CohortRuntime,
  getIdentity: () => Promise<UserIdentity>,
  context: unknown,
): Promise<{ slug?: string }> {
  let slug: string;
  try {
    slug = validateExperimentSlug(requestSlug);
  } catch {
    throw new RpcDecisionError(3, "Invalid experiment slug");
  }
  let identity: UserIdentity;
  try {
    identity = await getIdentity();
  } catch (error) {
    failures.publish({ error, request: context });
    throw new RpcDecisionError(13, "Internal server error");
  }
  try {
    const decision = await runtime.resolveCohort(identity, slug);
    const result = decodeAssignment(decision.slug, slug);
    return result === null ? {} : { slug: result };
  } catch (error) {
    if (error instanceof ExperimentNotFoundError) {
      throw new RpcDecisionError(5, "Experiment not found");
    }
    failures.publish({ error, request: context });
    throw new RpcDecisionError(13, "Internal server error");
  }
}
