import { buildSchema, graphql } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { createXpGraphQL } from "..";

const source = 'mutation { xpResolveCohort(slug: "checkout") { slug } }';
const hostSchema = () => buildSchema("type Query { host: String }");

describe("GraphQL schema composition", () => {
  it("adds a mutation root to a schema with only a query root", async () => {
    const resolveCohort = vi.fn(async () => ({ slug: "checkout_on" }));
    const schema = createXpGraphQL({
      connection: { driverKind: "postgres", resolveCohort },
    }).extendSchema(hostSchema());
    const result = await graphql({ schema, source, contextValue: { userId: 0 } });
    expect(result).toEqual({ data: { xpResolveCohort: { slug: "checkout_on" } } });
    expect(resolveCohort).toHaveBeenCalledWith(0, "checkout");
  });
  it("rejects collisions with an existing result type or mutation field", () => {
    const xp = createXpGraphQL();
    expect(() =>
      xp.extendSchema(
        buildSchema("type Query { host: String } type XPCohortResult { existing: Boolean }"),
      ),
    ).toThrow(/XPCohortResult/);
    expect(() =>
      xp.extendSchema(
        buildSchema("type Query { host: String } type Mutation { xpResolveCohort: Boolean }"),
      ),
    ).toThrow(/xpResolveCohort/);
  });
  it("honors header opt-in and async resolver precedence", async () => {
    const resolveCohort = vi.fn(async () => ({ slug: null }));
    const options = { connection: { driverKind: "postgres", resolveCohort }, header: "x-user" };
    const request = new Request("https://example.test", { headers: { "x-user": "header-user" } });
    const contextValue = { request, userId: "default-user" };
    const query = (schema: ReturnType<typeof hostSchema>) =>
      graphql({ schema, source, contextValue });
    await query(createXpGraphQL(options).extendSchema(hostSchema()));
    expect(resolveCohort).toHaveBeenLastCalledWith("header-user", "checkout");
    await query(createXpGraphQL({ ...options, userId: async () => 0 }).extendSchema(hostSchema()));
    expect(resolveCohort).toHaveBeenLastCalledWith(0, "checkout");
    await query(
      createXpGraphQL({ ...options, userId: async () => null }).extendSchema(hostSchema()),
    );
    expect(resolveCohort).toHaveBeenLastCalledWith(null, "checkout");
  });
  it("keeps identity callback errors available to host logging hooks", async () => {
    const failure = new Error("private auth failure");
    const xp = createXpGraphQL({
      userId: () => {
        throw failure;
      },
    });
    const result = await graphql({
      schema: xp.extendSchema(hostSchema()),
      source,
      contextValue: {},
    });
    expect(result.errors?.[0]?.originalError?.cause).toBe(failure);
    expect(result.errors?.[0]?.extensions["code"]).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(result)).not.toContain(failure.message);
  });
});
