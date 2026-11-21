import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { xpFastifyPlugin } from "..";
import { decisionRuntime, decisionVectors } from "../../__tests__/decisionVectors";

const hosts: ReturnType<typeof Fastify>[] = [];
function host() {
  const app = Fastify();
  hosts.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((app) => app.close()));
});

it("preserves the decision contract and host authentication", async () => {
  const app = host();
  const resolveCohort = vi.fn(decisionRuntime.resolveCohort);
  app.addHook("preHandler", async (req, reply) => {
    const session = req.headers["session"];
    if (session === "rejected" || session === "denied") {
      return reply.code(session === "rejected" ? 401 : 403).send({ error: "host policy" });
    }
    Object.assign(req, { userId: session });
  });
  app.register(xpFastifyPlugin, { runtime: { ...decisionRuntime, resolveCohort }, prefix: "/api" });
  for (const vector of decisionVectors) {
    resolveCohort.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/xp",
      headers: vector.id ? { session: vector.id } : {},
      payload: { slug: vector.slug, userId: "untrusted" },
    });
    expect(response.statusCode, vector.name).toBe(vector.status);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    if (vector.status === 200) expect(response.json()).toEqual({ slug: vector.result });
    if (vector.status === 500) expect(response.json()).toEqual({ error: "Internal server error" });
    if (vector.status === 401 || vector.status === 403)
      expect(response.json()).toEqual({ error: "host policy" });
    if ([401, 403, 400].includes(vector.status)) expect(resolveCohort).not.toHaveBeenCalled();
    else expect(resolveCohort).toHaveBeenCalledWith(vector.id, vector.slug);
  }
  const invalidJson = await app.inject({
    method: "POST",
    url: "/api/xp",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  expect(invalidJson.statusCode).toBe(400);
  expect(invalidJson.headers["cache-control"]).toBe("private, no-store");
});

it("keeps scoped runtimes, route options and identity sources independent", async () => {
  const app = host();
  const fromHeader = vi.fn(decisionRuntime.resolveCohort);
  const fromResolver = vi.fn(async () => ({ slug: "delivery-copy_control" }));
  app.addHook("preHandler", async (req) => {
    Object.assign(req, { userId: "fallback" });
  });
  app.register(xpFastifyPlugin, {
    runtime: { ...decisionRuntime, resolveCohort: fromHeader },
    prefix: "/a",
    header: "X-Account",
    route: "choose",
    resolveBody: async ({ slug }) => ({ variant: slug }),
  });
  app.register(xpFastifyPlugin, {
    runtime: { ...decisionRuntime, resolveCohort: fromResolver },
    prefix: "/b",
    header: "X-Account",
    userId: async () => 0,
  });
  app.get("/a/choose", async () => "host");
  app.options("/b/xp", async (_req, reply) => reply.code(204).send());
  const calls = await Promise.all(
    ["/a/choose", "/b/xp"].map((url) =>
      app.inject({
        method: "POST",
        url,
        headers: { "x-account": "trusted" },
        payload: { slug: "delivery-copy" },
      }),
    ),
  );
  expect(calls.map((res) => res.json())).toEqual([
    { variant: "delivery-copy_short" },
    { slug: "delivery-copy_control" },
  ]);
  expect(fromHeader).toHaveBeenCalledWith("trusted", "delivery-copy");
  expect(fromResolver).toHaveBeenCalledWith(0, "delivery-copy");
  await app.inject({ method: "POST", url: "/a/choose", payload: { slug: "delivery-copy" } });
  expect(fromHeader).toHaveBeenCalledWith(null, "delivery-copy");
  expect((await app.inject("/a/choose")).body).toBe("host");
  expect((await app.inject({ method: "OPTIONS", url: "/b/xp" })).statusCode).toBe(204);
  expect((await app.inject({ method: "POST", url: "/a/xp" })).statusCode).toBe(404);
});

it("logs the original resolver failure and returns a sanitized body", async () => {
  const app = host();
  const failure = new Error("private session detail");
  const log = vi.fn();
  app.addHook("onRequest", async (req) => {
    req.log.error = log;
  });
  app.register(xpFastifyPlugin, {
    runtime: decisionRuntime,
    userId: () => {
      throw failure;
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/xp",
    payload: { slug: "delivery-copy" },
  });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ error: "Internal server error" });
  expect(log).toHaveBeenCalledWith({ err: failure }, expect.any(String));
});
