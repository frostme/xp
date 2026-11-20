import { jsonLoader, record, type LoaderOptions } from "./shared";

const query = "mutation XpResolveCohort($slug: String!) { xpResolveCohort(slug: $slug) { slug } }";

export function createGraphQLLoader(options: LoaderOptions = {}) {
  return jsonLoader(
    options,
    "/graphql",
    (slug) => ({ operationName: "XpResolveCohort", query, variables: { slug } }),
    (payload) => {
      if (!record(payload) || "errors" in payload) throw new Error("xp GraphQL operation failed");
      const data = payload["data"];
      if (!record(data) || !record(data["xpResolveCohort"]))
        throw new TypeError("Missing xpResolveCohort result");
      return data["xpResolveCohort"]["slug"];
    },
  );
}
