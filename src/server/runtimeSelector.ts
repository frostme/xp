import type { CohortRuntime } from "~/interfaces/runtime";

import type { ServerOptions } from "./detectClient";

import server from "./index";

interface SelectionOptions extends ServerOptions {
  connection?: unknown;
}

function isRuntime(value: unknown): value is CohortRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "driverKind" in value &&
    "resolveCohort" in value &&
    typeof value.resolveCohort === "function"
  );
}

export function createRuntimeSelector({ connection, ...options }: SelectionOptions = {}) {
  if (connection !== undefined && typeof connection !== "string") {
    const runtime = isRuntime(connection) ? connection : server(connection, options);
    return (_registration: unknown) => runtime;
  }
  return (registration: unknown): CohortRuntime => {
    if (
      !isRuntime(registration) ||
      (connection !== undefined && registration.driverKind !== connection)
    ) {
      const expected = connection ? `a '${connection}' runtime` : "an xp runtime";
      throw new Error(
        `Expected ${expected}. Register the result of await initializeXp({ connection }) in app.locals.xp or context.xp.`,
      );
    }
    return registration;
  };
}
