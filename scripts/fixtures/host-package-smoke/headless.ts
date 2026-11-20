import type {
  AssignmentLoader as ReactLoader,
  CohortResult,
  InitialAssignments,
} from "@frostme/xp/react";

import {
  createXpRequest,
  createXpSession,
  type AssignmentLoader,
  type CohortLoader,
} from "@frostme/xp/client";
import assert from "node:assert/strict";

const oldLoader: ReactLoader = async (slug) => slug + "_on";
const load: AssignmentLoader = oldLoader;
const legacy: CohortLoader = async () => null;
await legacy("cart");
const preload = await createXpRequest(load).preload(["cart"]);
const initial: InitialAssignments = preload.initialAssignments;
const session = createXpSession({
  ...preload,
  initialAssignments: initial,
  loader: async () => null,
});
const result = (): CohortResult => ({
  ...session.getSnapshot("cart"),
  refresh: () => session.refresh("cart"),
});
assert.equal(result().slug, "cart_on");
const states: string[] = [];
const unsubscribe = session.subscribe("cart", () => states.push(result().status));
await result().refresh();
assert.deepEqual(states, ["loading", "ready"]);
assert.equal(result().slug, null);
unsubscribe();
session.dispose();
