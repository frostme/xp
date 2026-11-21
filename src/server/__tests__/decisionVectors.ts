import type { CohortRuntime } from "~/interfaces/runtime";

import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

export const decisionVectors = [
  {
    name: "assigned",
    id: "known",
    slug: "delivery-copy",
    status: 200,
    result: "delivery-copy_short",
    code: "OK",
  },
  { name: "winner", id: "known", slug: "winner", status: 200, result: "winner_short", code: "OK" },
  { name: "guest", id: null, slug: "delivery-copy", status: 200, result: null, code: "OK" },
  {
    name: "missing user",
    id: "absent",
    slug: "delivery-copy",
    status: 200,
    result: null,
    code: "OK",
  },
  {
    name: "guest, missing experiment",
    id: null,
    slug: "missing",
    status: 200,
    result: null,
    code: "OK",
  },
  { name: "paused", id: "known", slug: "paused", status: 200, result: null, code: "OK" },
  { name: "flag off", id: "known", slug: "flag", status: 200, result: null, code: "OK" },
  {
    name: "invalid slug even for guest",
    id: null,
    slug: "bad slug",
    status: 400,
    code: "INVALID_ARGUMENT",
  },
  { name: "unknown experiment", id: "known", slug: "missing", status: 404, code: "NOT_FOUND" },
  { name: "driver error", id: "known", slug: "broken", status: 500, code: "INTERNAL" },
  {
    name: "authentication required",
    id: "rejected",
    slug: "delivery-copy",
    status: 401,
    code: "UNAUTHENTICATED",
  },
  {
    name: "access denied",
    id: "denied",
    slug: "delivery-copy",
    status: 403,
    code: "PERMISSION_DENIED",
  },
] as const;

// Host authentication handles "rejected" and "denied" before this runtime is called.
export const decisionRuntime: CohortRuntime = {
  driverKind: "postgres",
  async resolveCohort(id, slug) {
    if (id === null || id === "absent" || slug === "paused" || slug === "flag")
      return { slug: null };
    if (slug === "missing") throw new ExperimentNotFoundError(slug);
    if (slug === "broken") throw new Error("private driver detail");
    return { slug: slug + "_short" };
  },
};
