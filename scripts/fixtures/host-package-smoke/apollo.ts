import type { XpGraphQLContext } from "@frostme/xp/server/graphql";

import { ApolloServer } from "@apollo/server";
import assert from "node:assert/strict";

import { schema, runtime } from "./graphql.js";

const server = new ApolloServer<XpGraphQLContext>({ schema });
await server.start();
try {
  const response = await server.executeOperation(
    { query: 'mutation { xpResolveCohort(slug: "checkout") { slug } }' },
    { contextValue: { xp: runtime, userId: 0 } },
  );
  assert.equal(response.body.kind, "single");
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.singleResult.data)), {
    xpResolveCohort: { slug: "checkout_on" },
  });
} finally {
  await server.stop();
}
