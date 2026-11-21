import { initializeXp } from "@frostme/xp/server";
import { xpMiddleware } from "@frostme/xp/server/express";
import { createXpManagementHandler } from "@frostme/xp/server/management";
import express from "express";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";

export const basePath = "/internal/experiments";
export const slug = "checkout-copy";
const experiments = [
  { slug: "legacy-color", cohorts: ["control", "off", "vivid"] },
  { slug: "summer-promo", cohorts: ["offer"], rollout: "off-first" },
];
const operatorCookie = { manage: "operator=operator-a", view: "operator=operator-b" };

export async function startHost(pool, allowCreate) {
  await writeFile("xp.config.json", JSON.stringify({ experiments, management: { allowCreate } }));
  let sample = 0;
  const runtime = await initializeXp({ connection: pool, random: () => sample });
  const app = express();
  app.locals.xp = runtime;
  app.get("/internal/experiments-health", (_request, response) => response.send("host is healthy"));
  app.use(
    basePath,
    createXpManagementHandler({
      basePath,
      runtime,
      access(request) {
        const cookies = (request.headers.cookie ?? "").split(/;\s*/);
        if (cookies.includes(operatorCookie.manage)) return "manage";
        if (cookies.includes(operatorCookie.view)) return "view";
        return "deny";
      },
    }),
  );
  const identities = new Map([
    ["Bearer a", "alice"],
    ["Bearer b", "bob"],
    ["Bearer s", "shopper"],
  ]);
  app.use(
    "/api",
    xpMiddleware({ userId: (request) => identities.get(request.get("authorization")) }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  function request(role, path, { body, tag, headers } = {}) {
    return globalThis.fetch(origin + basePath + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(operatorCookie[role] && { Cookie: operatorCookie[role] }),
        ...(body !== undefined && { "Content-Type": "application/json", Origin: origin }),
        ...(tag && { "If-Match": tag }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
  async function detail(target = slug, role = "manage") {
    const response = await request(role, `/api/experiments/${target}`);
    assert.equal(response.status, 200, `read ${target} as ${role}`);
    return { tag: response.headers.get("ETag"), ...(await response.json()) };
  }
  return {
    origin,
    request,
    detail,
    runtime,
    async open(browser, role) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      const cookie = operatorCookie[role];
      if (cookie)
        await context.addCookies([
          {
            name: "operator",
            value: cookie.split("=")[1],
            url: origin,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      return context.newPage();
    },
    async decision(user, target = slug, random = 0) {
      sample = random;
      const response = await globalThis.fetch(origin + "/api/xp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(user && { Authorization: `Bearer ${user}` }),
        },
        body: JSON.stringify({ slug: target }),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function storedMembers(pool, target = slug) {
  const { rows } = await pool.query(
    `SELECT m.user_id, c.slug FROM user_cohorts m
    JOIN cohorts c ON c.id = m.cohort_id JOIN experiments e ON e.id = m.experiment_id
    WHERE e.slug = $1 ORDER BY m.user_id`,
    [target],
  );
  return rows.map(({ user_id, slug }) => [user_id, slug]);
}
