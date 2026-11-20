import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";

async function start(cwd) {
  const server = spawn(process.execPath, ["dist/shop/server/server.mjs"], {
    cwd,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exit = once(server, "exit");
  const origin = new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("Angular SSR readiness timed out")), 30000);
    server.stdout.on("data", (chunk) => {
      log += chunk;
      const port = /ANGULAR_PORT=(\d+)/.exec(log);
      if (port) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + port[1]);
      }
    });
    exit.then(([code, signal]) => {
      clearTimeout(timer);
      reject(new Error(`Angular server exited ${code ?? signal}`));
    }, reject);
  });
  const stop = async () => {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return { origin: await origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function verifyGraph(stats) {
  const paths = Object.keys(stats.inputs);
  assert(paths.includes("src/xp/providers.ts"));
  assert(paths.some((p) => p.endsWith("/dist/client/angular/fesm2022/xp-angular.mjs")));
  const forbidden =
    /(?:^|\/)(?:react(?:-dom)?|ink|vue|solid-js|svelte|pg|mysql2|mssql|mongodb|sequelize|express|graphql-yoga|@apollo\/server|@aws-sdk\/[^/]+|@frostme\/xp\/dist\/(?:cli|server|adaptors|config|use-cases))(?:\/|$)/;
  for (const p of [
    ...paths,
    ...Object.values(stats.inputs).flatMap((i) =>
      i.imports.flatMap((r) => [r.path, r.original].filter(Boolean)),
    ),
  ]) {
    assert(
      !isBuiltin(p) && !forbidden.test(p),
      `Server or unrelated renderer in Angular browser graph: ${p}`,
    );
  }
}

async function expectText(page, selector, expected) {
  await page.waitForFunction(
    ([key, value]) => globalThis.document.querySelector(key)?.textContent.trim() === value,
    [selector, expected],
  );
}

async function verifyIdentity(browser, origin, opposite) {
  const context = await browser.newContext();
  try {
    if (opposite)
      await context.addCookies([{ url: origin, name: "shop_session", value: "opposite" }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => {
      if (/hydration|NG05\d+/.test(msg.text()) && ["warning", "error"].includes(msg.type()))
        errors.push(msg.text());
    });
    const requests = [];
    const failed = Promise.withResolvers();
    const pending = Promise.withResolvers();
    await page.route(/\/(xp|graphql-test|replacement)$/, async (route) => {
      const request = route.request(),
        body = request.postDataJSON();
      const endpoint = new URL(request.url()).pathname;
      const gql = endpoint !== "/xp";
      const slug = gql ? body.variables.slug : body.slug;
      assert.deepEqual(gql ? body.variables : body, { slug });
      if (gql) {
        assert.equal(body.operationName, "XpResolveCohort");
        assert.match(body.query, /mutation XpResolveCohort/);
      }
      requests.push({ endpoint, slug });
      if (slug === "absent") await pending.promise;
      if (slug === "failed") await failed.promise;
      const decision = { slug: slug + (endpoint === "/replacement" ? "_off" : "_on") };
      await route.fulfill({ json: gql ? { data: { xpResolveCohort: decision } } : decision });
    });
    const response = await page.goto(origin);
    const html = await response.text();
    const treatment = opposite ? "off" : "on";
    assert.match(response.headers()["cache-control"], /private, no-store/);
    assert(!html.includes("private-diagnostic"));
    const selector = (slug, part) => `[data-card="${slug}"] [data-${part}]`;
    for (const [slug, status, branch] of [
      ["banner", "ready", treatment],
      ["guest", "ready", "default"],
      ["failed", "error", "default"],
      ["absent", "loading", null],
    ]) {
      const section = html.match(
        new RegExp('<section data-card="' + slug + '">([\\s\\S]*?)</section>'),
      )?.[1];
      assert.ok(section);
      assert.match(section, new RegExp("data-xp-status[^>]*>" + status + "<"));
      assert.match(
        section,
        new RegExp(branch ? "data-xp-branch[^>]*>" + branch + "<" : "data-loading[^>]*>pending<"),
      );
      await expectText(page, selector(slug, "xp-status"), status);
      if (branch) await expectText(page, selector(slug, "xp-branch"), branch);
    }
    assert.equal(await page.locator("[data-duplicate]").count(), opposite ? 0 : 1);
    pending.resolve();
    await expectText(page, selector("absent", "xp-branch"), "on");
    assert.deepEqual(requests, [{ endpoint: "/xp", slug: "absent" }]);
    await page.locator('[data-card="failed"] button').click();
    await expectText(page, selector("failed", "xp-status"), "loading");
    await expectText(page, selector("banner", "xp-branch"), treatment);
    failed.resolve();
    await expectText(page, selector("failed", "xp-error"), "false");
    await expectText(page, selector("failed", "xp-branch"), "on");
    await page.locator("#retarget").click();
    await expectText(page, selector("other", "xp-branch"), "on");
    await page.locator("#nested").click();
    await expectText(page, "[data-custom]", "1");
    assert.equal(await page.locator("aside [data-xp-status]").textContent(), "loading");
    await page.locator("#nested").click();
    await expectText(page, "[data-abort]", "true");
    await page.locator("#graphql").click();
    await expectText(page, selector("banner", "xp-branch"), "on");
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-card="guest"] [data-xp-slug]')?.textContent ===
        "guest_on",
    );
    assert.equal(
      requests.filter((r) => r.slug === "banner" && r.endpoint === "/graphql-test").length,
      1,
    );
    await page.locator("#endpoint").click();
    await expectText(page, selector("banner", "xp-branch"), "off");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

export default async function angularProfile({ cwd, chromium, run, journey }) {
  const partial = await readFile(
    join(cwd, "node_modules/@frostme/xp/dist/client/angular/fesm2022/xp-angular.mjs"),
    "utf8",
  );
  assert.match(partial, /ɵɵngDeclareDirective/);
  const registration = await readFile(join(cwd, "src/app/app.config.ts"), "utf8");
  assert(registration.includes("provideAppXp()"));
  assert(
    registration.indexOf("provideClientHydration(),") < registration.lastIndexOf("provideAppXp()"),
  );
  run("bun", ["run", "ng", "build"], { env: { ...process.env, NG_BUILD_MAX_WORKERS: "2" } });
  verifyGraph(JSON.parse(await readFile(join(cwd, "dist/shop/browser-stats.json"), "utf8")));
  const app = await start(cwd);
  try {
    if (journey) {
      await journey(app.origin, chromium);
      return ["angular-yoga"];
    }
    const browser = await chromium.launch();
    try {
      await Promise.all([false, true].map((other) => verifyIdentity(browser, app.origin, other)));
    } finally {
      await browser.close();
    }
    return ["strict-aot", "ssr-hydration", "request-isolation", "reactive-bindings"];
  } finally {
    await app.stop();
  }
}
