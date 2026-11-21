import type { AddressInfo } from "node:net";

import express from "express";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseManagedDefinition } from "~/adaptors/validation/zod/seed";
import { NotFoundError } from "~/errors";
import { RolloutConflictError } from "~/errors/rolloutConflictError";
import { createExperimentManagement } from "~/use-cases/experiment/management";

import type { ManagementOptions } from "..";

import { createXpManagementHandler } from "..";

const basePath = "/shop/internal/experiments";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
});
async function host(allowCreate = true) {
  const directory = {
    slug: "checkout",
    name: "Checkout",
    enabled: true,
    type: "flag",
    winner: null,
  };
  const detail = vi.fn(async (slug: string, access: string) => {
    if (slug !== "checkout") throw new NotFoundError("Unknown experiment");
    return {
      ...directory,
      id: "xp-1",
      revision: 2,
      description: "",
      countsReadAt: null,
      cohorts: [],
      actions: access === "manage" ? ["pause"] : [],
    };
  });
  const list = vi.fn(async () => ({ items: [directory], nextCursor: "USER#host-private-user" }));
  const apply = vi.fn(async (_slug, revision, _command, id) => {
    if (revision !== 2 || id !== "xp-1") throw new RolloutConflictError();
  });
  const create = vi.fn(async () => directory);
  const service = { allowCreate, detail, list, apply, create };
  const app = express();
  app.use(
    basePath,
    createXpManagementHandler({
      runtime: { management: service as unknown as ManagementOptions["runtime"]["management"] },
      basePath,
      access(req) {
        const role = req.headers["role"];
        return role === "manage" || role === "view" ? role : "deny";
      },
    }),
  );
  app.get("/outside", (_req, res) => res.send("shop"));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const read = (path: string, role = "manage") =>
    fetch(origin + basePath + path, { headers: { role } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + basePath + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin, role: "manage", ...headers },
      body: JSON.stringify(body),
    });
  return { origin, read, post, service };
}

describe("private management mount", () => {
  it("isolates host capabilities, reads, cursors and unrelated host routes", async () => {
    const a = await host(),
      b = await host(false);
    expect(await (await a.read("/api/capabilities")).json()).toEqual({
      access: "manage",
      allowCreate: true,
    });
    expect(await (await b.read("/api/capabilities")).json()).toEqual({
      access: "manage",
      allowCreate: false,
    });
    expect(await (await a.read("/api/capabilities", "view")).json()).toEqual({
      access: "view",
      allowCreate: false,
    });
    const denied = await a.read("/api/experiments", "guest");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(await (await fetch(a.origin + "/outside")).text()).toBe("shop");
    const page = await (await a.read("/api/experiments?q=check")).json();
    expect(page.nextCursor).not.toContain("host-private-user");
    expect((await a.read("/api/experiments?q=check&cursor=" + page.nextCursor)).status).toBe(200);
    expect(a.service.list).toHaveBeenLastCalledWith({
      query: "check",
      cursor: "USER#host-private-user",
      limit: 25,
    });
    expect((await b.read("/api/experiments?q=check&cursor=" + page.nextCursor)).status).toBe(422);
    expect((await a.read("/api/experiments?q=other&cursor=" + page.nextCursor)).status).toBe(422);
    expect((await a.read("/api/experiments?limit=10000")).status).toBe(400);
    expect((await a.read("/api/experiments?q=a%00b")).status).toBe(400);
    expect((await a.read("/api/experiments/missing")).status).toBe(404);
    expect((await (await a.read("/api/experiments/checkout", "view")).json()).actions).toEqual([]);
  });
  it("checks access, create policy, origin, content, byte limits and the saved revision on direct requests", async () => {
    const a = await host(),
      b = await host(false),
      path = "/api/experiments";
    const payload = { slug: "checkout", cohorts: ["short"] };
    expect((await a.post(path, payload, { role: "view" })).status).toBe(403);
    expect((await b.post(path, payload)).status).toBe(403);
    expect((await a.post(path, payload, { origin: "https://foreign.example" })).status).toBe(403);
    expect((await a.post(path, payload, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await a.post(path, payload, { "content-type": "text/plain" })).status).toBe(415);
    expect((await a.post(path, "x".repeat(66000))).status).toBe(413);
    expect(a.service.create).toHaveBeenCalledTimes(0);
    expect((await a.post(path, payload)).status).toBe(201);
    const commandPath = path + "/checkout/commands",
      command = { type: "pause" };
    expect((await a.post(commandPath, command)).status).toBe(428);
    const tag = (await a.read(path + "/checkout")).headers.get("etag");
    assert.ok(tag);
    expect((await a.post(commandPath, command, { "if-match": tag, role: "view" })).status).toBe(
      403,
    );
    expect((await a.post(commandPath, { type: "unsupported" }, { "if-match": tag })).status).toBe(
      422,
    );
    expect((await a.post(commandPath, command, { "if-match": tag })).status).toBe(200);
    a.service.apply.mockRejectedValueOnce(new RolloutConflictError());
    const conflict = await a.post(commandPath, command, { "if-match": tag });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).refresh).toBe(basePath + path + "/checkout");
  });
  it("keeps a failed count read unknown and permits a fresh read", async () => {
    const definition = parseManagedDefinition({ slug: "checkout", cohorts: ["short"] });
    const store = {
      findBySlug: async () => ({
        ...definition,
        id: 1,
        revision: 1,
        rolloutPhase: "awaiting-launch",
        winner: "checkout_off",
        enabled: true,
      }),
      countMemberships: vi
        .fn()
        .mockRejectedValueOnce(new Error())
        .mockResolvedValue({ checkout_off: 0, checkout_short: 0 }),
    };
    const management = createExperimentManagement(store as never, false, parseManagedDefinition);
    const failed = await management.detail("checkout", "view");
    expect(failed.countsReadAt).toBeNull();
    expect(failed.cohorts.map((c) => c.memberships)).toEqual([null, null]);
    expect((await management.detail("checkout", "view")).cohorts.map((c) => c.memberships)).toEqual(
      [0, 0],
    );
  });
});
