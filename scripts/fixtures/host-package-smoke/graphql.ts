import { createXpGraphQL, type XpGraphQLContext } from "@frostme/xp/server/graphql";
import { buildSchema } from "graphql";

export const xp = createXpGraphQL<XpGraphQLContext>();
export const schema = xp.extendSchema(buildSchema("type Query { hello: String }"));
export const runtime = {
  driverKind: "postgres",
  async resolveCohort(userId: unknown, slug: string) {
    return { slug: userId === 0 ? slug + "_on" : null };
  },
};
