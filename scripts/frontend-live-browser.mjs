import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

function sessionCookie(req) {
  return /(?:^|;\s*)xp_session=([\w-]+)(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
}

export async function listener(handler) {
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The browser uses its same-origin route. Only this trusted fixture gateway turns a session cookie
 * into the authorization header expected by the shared installed HTTP hosts. */
export async function authenticatedApi(transport) {
  const requests = [];
  let release;
  let held = false;
  const proxy = await listener(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const token = sessionCookie(req);
    const authorization = token ? "Bearer " + token : req.headers.authorization;
    const response = await globalThis.fetch(transport.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization && { authorization }) },
      body: JSON.stringify(body),
    });
    const reply = await response.json();
    requests.push({ authorization, body, status: response.status, reply });
    if (held && authorization === "Bearer session-2")
      await new Promise((resolve) => {
        release = resolve;
      });
    res.writeHead(response.status, {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    });
    res.end(JSON.stringify(reply));
  });
  return {
    ...proxy,
    requests,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      release?.();
    },
  };
}

async function frontGateway(app, api, endpoint) {
  return listener(async (req, res) => {
    const path = new URL(req.url, "http://localhost");
    const target = path.pathname === endpoint ? api : app;
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const remote = await globalThis.fetch(new URL(path.pathname + path.search, target), {
      method: req.method,
      headers: {
        ...(req.headers.cookie && { cookie: req.headers.cookie }),
        ...(req.headers["content-type"] && { "content-type": req.headers["content-type"] }),
      },
      ...(body.length && { body: Buffer.concat(body) }),
    });
    const headers = Object.fromEntries(remote.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"])
      delete headers[name];
    res.writeHead(remote.status, headers);
    res.end(Buffer.from(await remote.arrayBuffer()));
  });
}

export async function runLiveBrowser({
  profile,
  chromium,
  app,
  api,
  transport,
  database,
  assignedSlugs,
}) {
  const rest = transport.protocol === "rest";
  const gateway = await frontGateway(app, api.origin, rest ? "/xp" : "/graphql");
  const browser = await chromium.launch();
  const plain = profile.id === "astro";
  try {
    const context = await browser.newContext({ javaScriptEnabled: !plain });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const session = async (ctx, token) => {
      await ctx.clearCookies();
      if (token)
        await ctx.addCookies([
          { name: "xp_session", value: token, url: gateway.origin, httpOnly: true },
        ]);
    };
    const visit = async (tab, slug = "delivery-copy") => {
      const response = await tab.goto(gateway.origin + "/journey?slug=" + slug);
      assert.equal(response.status(), 200);
      if (plain) assert.match(response.headers()["cache-control"], /private, no-store/);
    };
    const decision = async (tab, status, slug) => {
      await tab
        .locator("[data-xp-status]")
        .filter({ hasText: new RegExp("^" + status + "$") })
        .waitFor({ timeout: 15000 });
      const qualified = await tab.locator("[data-xp-slug]").innerText();
      if (slug !== undefined) assert.equal(qualified, slug ?? "");
      assert.equal(await tab.locator("[data-xp-error]").innerText(), String(status === "error"));
      assert.equal(
        await tab.locator("[data-xp-branch]").innerText(),
        qualified.split("_")[1] ?? "default",
      );
      return qualified;
    };
    function requestResult(after, slug) {
      const seen = api.requests.slice(after);
      assert.equal(seen.length, 1, profile.id + " duplicate or missing decision requests");
      const [{ body, reply, status }] = seen;
      if (rest) assert.deepEqual(body, { slug });
      else {
        assert.deepEqual(Object.keys(body).sort(), ["operationName", "query", "variables"]);
        assert.equal(body.operationName, "XpResolveCohort");
        assert.deepEqual(body.variables, { slug });
      }
      return {
        slug: rest ? reply.slug : reply.data?.xpResolveCohort?.slug,
        status,
        error: reply.errors?.[0]?.extensions.code,
      };
    }
    await session(context, "session-1");
    let sticky;
    for (let i = 0; i < 2; i++) {
      const start = api.requests.length;
      if (i) await page.reload();
      else await visit(page);
      const visible = await decision(page, "ready", sticky);
      assert.match(visible, /^delivery-copy_(control|short|detailed)$/);
      assert.equal(requestResult(start, "delivery-copy").slug, visible);
      assert.deepEqual(await assignedSlugs(database.pool, "shopper"), [visible]);
      sticky = visible;
    }
    const memberships = async () =>
      (await database.pool.query("SELECT COUNT(*) FROM user_cohorts")).rows[0].count;
    const before = await memberships();
    for (const guest of [null, "unregistered-session"]) {
      await session(context, guest);
      const start = api.requests.length;
      await visit(page);
      await decision(page, "ready", null);
      assert.equal(requestResult(start, "delivery-copy").slug, null);
    }
    await session(context, "session-1");
    const start = api.requests.length;
    await visit(page, "missing-experiment");
    await decision(page, "error", null);
    const failed = requestResult(start, "missing-experiment");
    if (rest) assert.equal(failed.status, 404);
    else assert.equal(failed.error, "NOT_FOUND");
    assert.equal(await memberships(), before);
    await session(context, "session-2");
    if (plain) {
      const other = await browser.newContext({ javaScriptEnabled: false });
      await session(other, "session-3");
      const second = await other.newPage();
      await Promise.all([visit(page), visit(second)]);
      await Promise.all([
        decision(page, "ready", "delivery-copy_short"),
        decision(second, "ready", "delivery-copy_control"),
      ]);
      await other.close();
    } else {
      api.hold();
      const offset = api.requests.length;
      await visit(page);
      const deadline = Date.now() + 15000;
      while (api.requests.length === offset && Date.now() < deadline) await delay(20);
      assert.equal(requestResult(offset, "delivery-copy").slug, "delivery-copy_short");
      await session(context, "session-3");
      await page.locator("[data-xp-switch]").click();
      await decision(page, "ready", "delivery-copy_control");
      api.release();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
          ),
      );
      await decision(page, "ready", "delivery-copy_control");
    }
    assert.deepEqual(await assignedSlugs(database.pool, "alice"), ["delivery-copy_short"]);
    assert.deepEqual(await assignedSlugs(database.pool, "bob"), ["delivery-copy_control"]);
    assert.deepEqual(errors, []);
    console.log(profile.id, transport.name, "Chromium and PostgreSQL verified", sticky);
  } finally {
    api.release();
    await browser.close();
    await gateway.close();
  }
}
