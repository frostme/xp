import { it, expect } from "vitest";

import { createGraphQLLoader } from "../graphql";
import { loaderContract } from "./contract";

loaderContract("GraphQL", createGraphQLLoader, (value) => ({ data: { xpResolveCohort: value } }));
it.each([
  { data: {} },
  { data: { xpResolveCohort: { slug: "checkout_a" } }, errors: [{ message: "forbidden" }] },
])("rejects incomplete or erroneous GraphQL results", async (payload) => {
  const loader = createGraphQLLoader({ fetch: async () => Response.json(payload) });
  await expect(loader("checkout")).rejects.toThrow();
});
