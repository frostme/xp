import { createGraphQLLoader } from "@frostme/xp/client";
import { createSchema, createYoga } from "graphql-yoga";
import assert from "node:assert/strict";

import { runtime, xp } from "./graphql.js";

const schema = createSchema({
  typeDefs: ["type Query { hello: String }", xp.typeDefs],
  resolvers: [xp.resolvers],
});
const yoga = createYoga({ schema, context: () => ({ xp: runtime, userId: 0 }), logging: false });
const load = createGraphQLLoader({ endpoint: "http://xp.test/graphql", fetch: yoga.fetch });
assert.equal(await load("checkout"), "checkout_on");
