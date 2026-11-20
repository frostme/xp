import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

async function waitForOrigin(server) {
  const timer = setTimeout(() => server.kill(), 20_000);
  try {
    for await (const line of createInterface({ input: server.stdout })) {
      if (line.startsWith("XP_ORIGIN=")) return line.slice("XP_ORIGIN=".length);
    }
    throw new Error("Production server exited before listening");
  } finally {
    clearTimeout(timer);
  }
}

function section(doc, slug) {
  const part = doc.match(
    new RegExp('<section data-experiment="' + slug + '">([\\s\\S]*?)</section>'),
  );
  assert.ok(part, "Missing server-rendered " + slug);
  return part[1];
}

async function exercise(browser, origin, kit) {
  const headers = { cookie: "viewer=other" };
  const [first, other] = await Promise.all([fetch(origin), fetch(origin, { headers })]);
  for (const response of [first, other]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const [doc, docOther] = await Promise.all([first.text(), other.text()]);
  assert.doesNotMatch(doc, /private diagnosis/);
  assert.match(section(doc, "assigned"), /treatment/);
  assert.match(section(docOther, "assigned"), /fallback/);
  assert.match(section(doc, "empty"), /data-status="ready"/);
  assert.match(section(doc, "failed"), /data-status="error"/);
  assert.match(section(doc, "absent"), /pending/);

  const clients = [];
  for (const viewer of ["first", "other"]) {
    const context = await browser.newContext();
    await context.addCookies([{ name: "viewer", value: viewer, url: origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/hydration|mismatch/i.test(message.text())) errors.push(message.text());
    });
    const requests = [];
    let releaseRetry;
    const retry = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    await page.route(
      (url) => url.pathname === "/xp" || url.pathname === "/graphql",
      async (route) => {
        const r = route.request();
        const body = r.postDataJSON();
        const slug = body.slug ?? body.variables.slug;
        const graphql = new URL(r.url()).pathname === "/graphql";
        assert.equal(r.method(), "POST");
        if (graphql) {
          assert.deepEqual(body.variables, { slug });
          assert.match(body.query, /mutation XpResolveCohort/);
        } else assert.deepEqual(body, { slug });
        requests.push({ slug, graphql });
        if (slug === "failed") await retry;
        const value = {
          slug: slug === "unlisted" ? "unlisted_other" : slug === "assigned" ? null : slug + "_on",
        };
        await route.fulfill({ json: graphql ? { data: { xpResolveCohort: value } } : value });
      },
    );
    clients.push({ page, context, requests, releaseRetry, errors });
  }
  const [{ page, requests, releaseRetry }, b] = clients;
  const cases = ["concurrent requests"];
  await Promise.all(
    clients.map(async (client) => {
      await client.page.goto(origin);
      await client.page.locator('[data-experiment="absent"] b').first().waitFor();
      assert.equal(client.requests.filter((r) => r.slug === "absent").length, 1);
      assert.equal(
        client.requests.filter((r) => ["assigned", "empty", "failed"].includes(r.slug)).length,
        0,
      );
      assert.equal(
        await client.page.locator('[data-experiment="empty"] [data-xp-status]').textContent(),
        "ready",
      );
      assert.equal(
        await client.page.locator('[data-experiment="failed"] [data-xp-status]').textContent(),
        "error",
      );
      await client.page.locator('[data-custom] [data-status="ready"]').waitFor();
      assert.match(await client.page.locator("[data-custom]").textContent(), /local_on.*true/);
    }),
  );
  assert.equal(await b.page.locator('[data-experiment="assigned"] b').textContent(), "fallback");
  assert.deepEqual(await page.locator('[data-experiment="assigned"] b').allTextContents(), [
    "treatment",
    "again",
  ]);
  await page.getByText("standalone", { exact: true }).waitFor();
  cases.push("hydration", "custom loader");
  await page.locator('[data-experiment="failed"] [data-retry]').click();
  await page.locator('[data-experiment="failed"] i').waitFor();
  assert.equal(await page.locator('[data-experiment="assigned"] b').count(), 2);
  releaseRetry();
  await page.locator('[data-experiment="failed"] b').filter({ hasText: "treatment" }).waitFor();
  assert.equal(requests.filter((r) => r.slug === "failed").length, 1);
  cases.push("retry");
  await page.getByRole("button", { name: "Change experiment" }).click();
  await page.locator('[data-experiment="unlisted"] [data-status="ready"]').waitFor();
  assert.equal(await page.locator('[data-experiment="unlisted"] b').count(), 0);
  cases.push("reactive slug and lazy snippets");
  if (kit) {
    await page.evaluate(() => {
      window.xpDocument = "original";
    });
    await page.getByRole("link", { name: "Next route" }).click();
    await page.getByRole("heading", { name: "Next route" }).waitFor();
    assert.equal(await page.evaluate(() => window.xpDocument), "original");
    assert.equal(await page.locator("[data-xp-slug]").textContent(), "assigned_on");
    cases.push("client navigation");
    await page.getByRole("button", { name: "Rotate account" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-xp-status]")?.textContent === "ready" &&
        document.querySelector("[data-xp-slug]")?.textContent === "",
    );
    assert.equal(requests.filter((r) => r.slug === "assigned").length, 1);
    const redirect = await fetch(origin + "/?redirect", { redirect: "manual" });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get("location"), "/next");
    cases.push("account invalidation");
  } else {
    await page.goto(origin + "/?graphql");
    await page.locator('[data-experiment="absent"] [data-status="ready"]').waitFor();
    assert.ok(requests.some((r) => r.slug === "absent" && r.graphql));
    cases.push("GraphQL");
  }
  for (const client of clients) {
    assert.deepEqual(client.errors, []);
    await client.context.close();
  }
  return cases;
}

// A second package boundary uses JavaScript, a stock CSR mount and hoisted dependencies.
async function javascriptSetup(cwd, run) {
  const app = path.join(cwd, "javascript-app");
  await mkdir(path.join(app, "src"), { recursive: true });
  await writeFile(
    path.join(app, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: { svelte: "5.59.0" },
    }),
  );
  const appFile = path.join(app, "src/App.svelte");
  const original = "<h1>Existing storefront</h1>\n";
  await writeFile(appFile, original);
  await writeFile(
    path.join(app, "src/main.js"),
    'import App from "./App.svelte";\nimport {mount} from "svelte";\nmount(App, {target: document.body});\n',
  );
  const args = [
    "setup",
    "--cwd",
    app,
    "--scope",
    "frontend",
    "--frontend",
    "svelte",
    "--non-interactive",
  ];
  const binary = path.join(cwd, "node_modules/.bin/xp");
  const preview = run(binary, [...args, "--dry-run"]);
  assert.match(preview, /src\/App\.svelte/);
  assert.equal(await readFile(appFile, "utf8"), original);
  assert.throws(() => run(binary, args, { stdio: "pipe" }));
  assert.equal(await readFile(appFile, "utf8"), original);
  run(binary, [...args, "--yes"]);
  const patched = await readFile(appFile, "utf8");
  assert.match(
    patched,
    /<script>[^]*AppXp[^]*<\/script>[^]*<AppXp><h1>Existing storefront<\/h1><\/AppXp>/,
  );
  const wrapper = await readFile(path.join(app, "src/xp/AppXp.svelte"), "utf8");
  assert.doesNotMatch(wrapper, /lang="ts"/);
  await writeFile(appFile, patched + "<!-- application edit -->");
  run(binary, [...args, "--yes"]);
  assert.equal(await readFile(appFile, "utf8"), patched + "<!-- application edit -->");
}

async function unknownServerLoad(cwd, run) {
  const app = path.join(cwd, "custom-kit");
  await mkdir(path.join(app, "src/routes"), { recursive: true });
  const manifest = await readFile(path.join(cwd, "package.json"), "utf8");
  await writeFile(path.join(app, "package.json"), manifest);
  const original = "export const load = (event) => { throw { message: event.url.pathname }; };\n";
  const file = path.join(app, "src/routes/+layout.server.js");
  await writeFile(file, original);
  const output = run(path.join(cwd, "node_modules/.bin/xp"), [
    "setup",
    "--cwd",
    app,
    "--frontend",
    "sveltekit",
    "--non-interactive",
    "--yes",
  ]);
  assert.match(output, /preserve existing redirects/);
  assert.equal(await readFile(file, "utf8"), original);
}

export async function testProfile({ cwd, run, profile, chromium, setup, journey }) {
  const kit = profile.id === "sveltekit";
  if (!journey) {
    if (kit) await unknownServerLoad(cwd, run);
    else await javascriptSetup(cwd, run);
  }
  const host = kit ? "src/routes/+layout.svelte" : "src/App.svelte";
  const read = (file) => readFile(path.join(cwd, file), "utf8");
  const before = await read(host);
  assert.match(before, /<AppXp \{\.\.\./);
  await appendFile(path.join(cwd, host), "\n<!-- host customisation -->\n");
  setup(["--yes"]);
  assert.equal(await read(host), before + "\n<!-- host customisation -->\n");
  if (kit) run("bun", ["x", "--no-install", "svelte-kit", "sync"]);
  run("bun", [
    "x",
    "--no-install",
    "svelte-check",
    "--tsconfig",
    "./tsconfig.json",
    "--fail-on-warnings",
  ]);
  run("bun", ["x", "--no-install", "vite", "build"]);
  if (!kit)
    run("bun", [
      "x",
      "--no-install",
      "vite",
      "build",
      "--ssr",
      "src/entry-server.ts",
      "--outDir",
      "ssr",
    ]);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(server, "exit");
  try {
    const origin = await waitForOrigin(server);
    if (journey) {
      await journey(origin);
      return [`${profile.id}-${profile.journey}`];
    }
    const browser = await chromium.launch();
    try {
      return [...(await exercise(browser, origin, kit)), "source registration"];
    } finally {
      await browser.close();
    }
  } finally {
    if (server.exitCode === null && !server.signalCode) server.kill();
    await closed;
  }
}
