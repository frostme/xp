import type { AddressInfo } from "node:net";

import express from "express";
import { once } from "node:events";
import { afterEach, it, expect, vi } from "vitest";

import { createRestLoader } from "~/client";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";

import { xpMiddleware } from "..";

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closing.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
function fake(suffix = "on") {
  const resolveCohort = vi.fn(async (id: unknown, slug: string) => {
    if (id === null || id === "absent") return { slug: null };
    if (slug === "missing") throw new ExperimentNotFoundError(slug);
    if (slug === "broken") throw new Error("private driver info");
    return { slug: slug + "_" + suffix };
  });
  return { driverKind: "postgres", resolveCohort };
}
function application(runtime: unknown, handler = xpMiddleware({})) {
  const app = express();
  app.locals.xp = runtime;
  const router = express.Router();
  router.use((req, _res, next) => {
    Object.assign(req, { userId: req.get("session") });
    next();
  });
  router.use(handler);
  router.get("/xp", (_req, res) => res.send("sibling"));
  router.post("/other", (req, res) => res.json({ untouched: req.body === undefined }));
  app.use("/api", router);
  return app;
}
it("Express bare mount coexists with auth, sibling routes and independent apps", async () => {
  const runtime = fake();
  const app = application(runtime, xpMiddleware);
  const url = await listen(app);
  const second = await listen(application(fake("control"), xpMiddleware));
  const load = (host: string, id?: string) =>
    createRestLoader({ experimentHost: host + "/api", headers: id ? { session: id } : {} });
  expect(await load(url, "alice")("checkout")).toBe("checkout_on");
  expect(await load(second, "alice")("checkout")).toBe("checkout_control");
  expect(await load(url)("checkout")).toBeNull();
  expect(await load(url, "absent")("checkout")).toBeNull();
  await expect(load(url, "alice")("missing")).rejects.toThrow("404");
  const basic = await fetch(url + "/api/xp", {
    method: "POST",
    headers: { "content-type": "application/json", session: "alice" },
    body: '{"slug":"broken"}',
  });
  expect(basic.status).toBe(500);
  expect(await basic.text()).not.toContain("private driver info");
  expect(basic.headers.get("cache-control")).toBe("private, no-store");
  expect(await (await fetch(url + "/api/xp")).text()).toBe("sibling");
  const other = await fetch(url + "/api/other", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(await other.json()).toEqual({ untouched: true });
  for (const body of ["{", '{"slug":"bad slug"}', "{}"]) {
    const response = await fetch(url + "/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  }
});
it("Express custom route, trusted header, resolver precedence, decoder and explicit runtime", async () => {
  const runtime = fake();
  const app = application(
    fake("unused"),
    xpMiddleware({
      route: "variant",
      header: "x-account",
      connection: runtime,
      resolveBody: ({ slug }) => ({ variant: slug }),
    }),
  );
  const url = await listen(app);
  const load = createRestLoader({
    endpoint: url + "/api/variant",
    headers: { "x-account": "bob", session: "other" },
    decode: (payload) => (payload as { variant: unknown }).variant,
  });
  expect(await load("checkout")).toBe("checkout_on");
  expect(runtime.resolveCohort).toHaveBeenCalledWith("bob", "checkout");
  const resolved = await listen(
    application(runtime, xpMiddleware({ userId: async () => 0, header: "ignored" })),
  );
  expect(await createRestLoader({ experimentHost: resolved + "/api" })("checkout")).toBe(
    "checkout_on",
  );
  expect(runtime.resolveCohort).toHaveBeenCalledWith(0, "checkout");
  const rejected = await listen(
    application(
      runtime,
      xpMiddleware({
        userId: () => {
          throw new Error("private auth detail");
        },
      }),
    ),
  );
  await expect(createRestLoader({ experimentHost: rejected + "/api" })("checkout")).rejects.toThrow(
    "500",
  );
});
