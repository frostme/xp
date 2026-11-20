import { xpMiddleware } from "@frostme/xp";
import cli from "@frostme/xp/cli";
import { createGraphQLLoader, createRestLoader, type CohortLoader } from "@frostme/xp/client";
import server, { initializeXp } from "@frostme/xp/server";
import assert from "node:assert/strict";

const loaders: CohortLoader[] = [createGraphQLLoader(), createRestLoader()];
for (const entry of [xpMiddleware, cli, server, initializeXp, ...loaders]) {
  assert.equal(typeof entry, "function");
}
