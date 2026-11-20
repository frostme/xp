import type { AddressInfo } from "node:net";

import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CohortRuntime } from "~/interfaces/runtime";

import { createGraphQLLoader } from "~/client";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { createXpGraphQL, type XpGraphQLContext } from "..";

const experiment = "checkout-banner";
const operation =
  "mutation XpResolveCohort($slug: String!) { xpResolveCohort(slug: $slug) { slug } }";

function requestIdentity(header: string | null): string | number | null {
  return header === "zero-account" ? 0 : header;
}

function testRuntime(): CohortRuntime {
  const known = new Map<string | number, string | null>([
    [0, "checkout-banner_on"],
    ["b", "checkout-banner_control"],
    ["flag-off", null],
  ]);
  return {
    driverKind: "postgres",
    async resolveCohort(id, slug) {
      if (id == null || !known.has(id)) return { slug: null };
      if (slug === "unavailable") throw new Error("private database failure");
      if (slug !== experiment) throw new ExperimentNotFoundError(slug);
      return { slug: known.get(id)! };
    },
  };
}

interface LiveHost {
  endpoint: string;
  close(): Promise<void>;
}

async function startHost(host: "Yoga" | "Apollo"): Promise<LiveHost> {
  const runtime = testRuntime();
  const xp = createXpGraphQL();
  if (host === "Yoga") {
    const schema = createSchema({
      typeDefs: ["type Query { greeting: String! }", xp.typeDefs],
      resolvers: [{ Query: { greeting: () => "hello" } }, xp.resolvers],
    });
    const yoga = createYoga({
      schema,
      logging: false,
      context: ({ request }) => ({
        xp: runtime,
        userId: requestIdentity(request.headers.get("x-account")),
      }),
    });
    const http = createServer(yoga);
    await new Promise<void>((resolve, reject) =>
      http.once("error", reject).listen(0, "127.0.0.1", resolve),
    );
    return {
      endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}/graphql`,
      close: () =>
        new Promise((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }
  const existing = createSchema({
    typeDefs:
      "schema { query: Query mutation: Commands } type Query { greeting: String! } type Commands { appMutation: Int! }",
    resolvers: { Query: { greeting: () => "hello" }, Commands: { appMutation: () => 42 } },
  });
  const apollo = new ApolloServer<XpGraphQLContext>({ schema: xp.extendSchema(existing) });
  const { url } = await startStandaloneServer(apollo, {
    listen: { host: "127.0.0.1", port: 0 },
    context: async ({ req }) => {
      const header = req.headers["x-account"];
      return { xp: runtime, userId: requestIdentity(typeof header === "string" ? header : null) };
    },
  });
  return { endpoint: url, close: () => apollo.stop() };
}

describe.each(["Yoga", "Apollo"] as const)("%s GraphQL HTTP integration", (host) => {
  let app: LiveHost;
  beforeEach(async () => {
    app = await startHost(host);
  });
  afterEach(async () => {
    await app?.close();
  });
  async function post(query: string, variables: object, account?: string) {
    const response = await fetch(app.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(account ? { "x-account": account } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    return { status: response.status, body: await response.json() };
  }
  it("uses a named mutation and the host's request identity for each loader call", async () => {
    const load = (account?: string) =>
      createGraphQLLoader({
        endpoint: app.endpoint,
        headers: account ? { "x-account": account } : {},
        fetch: async (input, init) => {
          const body = JSON.parse(String(init?.body));
          expect(body.query).toMatch(/mutation\s+XpResolveCohort\s*\(\s*\$slug\s*:\s*String!/);
          expect(body.variables).toEqual({ slug: experiment });
          return fetch(input, init);
        },
      })(experiment);
    expect(
      await Promise.all([
        load("zero-account"),
        load("b"),
        load("flag-off"),
        load(),
        load("absent"),
      ]),
    ).toEqual(["checkout-banner_on", "checkout-banner_control", null, null, null]);
  });
  it("serves both guest cases as successful null decisions and preserves application fields", async () => {
    for (const account of [undefined, "absent"]) {
      expect(await post(operation, { slug: experiment }, account)).toEqual({
        status: 200,
        body: { data: { xpResolveCohort: { slug: null } } },
      });
    }
    expect((await post("{ greeting }", {})).body).toEqual({ data: { greeting: "hello" } });
    if (host === "Apollo")
      expect((await post("mutation { appMutation }", {})).body).toEqual({
        data: { appMutation: 42 },
      });
  });
  it("distinguishes bad input, missing experiments and internal failures over HTTP", async () => {
    for (const [slug, account, code] of [
      ["invalid Slug", undefined, "BAD_USER_INPUT"],
      ["no-such-experiment", "b", "NOT_FOUND"],
      ["unavailable", "b", "INTERNAL_SERVER_ERROR"],
    ] as const) {
      const { body } = await post(operation, { slug }, account);
      expect(body.errors[0].extensions.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("private database failure");
    }
    await expect(
      createGraphQLLoader({ endpoint: app.endpoint, headers: { "x-account": "b" } })(
        "no-such-experiment",
      ),
    ).rejects.toThrow();
  });
});
