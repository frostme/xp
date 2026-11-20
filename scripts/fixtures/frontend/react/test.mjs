import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function checkGraph(graph) {
  const inputs = Object.entries(graph.inputs);
  const paths = inputs.map(([file]) => file);
  for (const file of ["src/xp/provider.tsx", "dist/client/react/index.js"]) {
    assert(
      paths.some((path) => path.endsWith(file)),
      file,
    );
  }
  const forbidden =
    /(?:^|\/)(?:ink|pg|mysql2|mongodb|mssql|tedious|sequelize|@angular|svelte|solid-js|vue|astro|dist\/(?:server|cli|adaptors|frameworks))(?:\/|$)/;
  for (const [file, module] of inputs) {
    for (const path of [
      file,
      ...module.imports.flatMap((dep) => [dep.path, dep.original].filter(Boolean)),
    ]) {
      assert(!isBuiltin(path) && !forbidden.test(path), path);
    }
  }
}

export default async function testReact({ cwd, chromium, run }) {
  const source = await readFile(join(cwd, "src/main.tsx"), "utf8");
  assert.match(source, /<AppXp>\s*<CheckoutBanner/);
  run("bun", ["run", "tsc", "-p", "tsconfig.json"]);
  run("bun", [
    "build",
    "src/main.tsx",
    "src/hydrate.tsx",
    "--target=browser",
    "--production",
    "--outdir=web",
    "--metafile=graph.json",
  ]);
  checkGraph(JSON.parse(await readFile(join(cwd, "graph.json"), "utf8")));
  run("bun", [
    "build",
    "src/server.tsx",
    "--target=node",
    "--packages=external",
    "--production",
    "--outfile=build/server.mjs",
  ]);
  const { renderPage } = await import(pathToFileURL(join(cwd, "build/server.mjs")).href);
  const server = createServer(async (req, res) => {
    try {
      const path = req.url;
      if (path === "/main.js" || path === "/hydrate.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(await readFile(join(cwd, "web", path.slice(1))));
      } else if (path === "/csr") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<!doctype html><div id="root"></div><script type="module" src="/main.js"></script>',
        );
      } else {
        const page = await renderPage(req.headers.cookie === "session=test-b" ? "B" : "A");
        res.writeHead(200, { "content-type": "text/html", "cache-control": "private, no-store" });
        res.end(page);
      }
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port;
  const completed = [];
  let browser;
  try {
    browser = await chromium.launch();
    const problems = [];
    async function visit(account) {
      const context = await browser.newContext();
      await context.addCookies([{ name: "session", value: "test-" + account, url }]);
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      const requests = [];
      const retry = Promise.withResolvers();
      await page.route("**/xp", async (route) => {
        const { slug, ...extras } = route.request().postDataJSON();
        assert.deepEqual(extras, {});
        requests.push(slug);
        if (slug === "failed") await retry.promise;
        await route.fulfill({ json: { slug: slug + "_on" } });
      });
      return { page, requests, retry };
    }
    const a = await visit("a");
    await a.page.goto(url + "/csr");
    await a.page.getByText("New checkout offer", { exact: true }).waitFor();
    assert.deepEqual(a.requests, ["checkout-banner"]);
    a.requests.length = 0;
    completed.push("patched-csr");
    const b = await visit("b");
    await Promise.all(
      [
        [a, "on"],
        [b, "off"],
      ].map(async ([client, treatment]) => {
        const response = await client.page.goto(url);
        assert.equal(response.headers()["cache-control"], "private, no-store");
        const html = await response.text();
        assert(!html.includes("private host error"));
        for (const [id, branch, status] of [
          ["offer", treatment, "ready"],
          ["guest", "default", "ready"],
          ["failed", "default", "error"],
          ["missing", "pending", "loading"],
        ]) {
          assert(
            html.includes(
              '<section id="' + id + '"><b>' + branch + "</b><output>" + status + "</output>",
            ),
            id + ": " + html,
          );
        }
        await client.page.locator("#missing b").getByText("on", { exact: true }).waitFor();
        for (const [id, branch, status] of [
          ["offer", treatment, "ready"],
          ["guest", "default", "ready"],
          ["failed", "default", "error"],
          ["missing", "on", "ready"],
        ]) {
          assert.equal(await client.page.locator("#" + id + " b").textContent(), branch);
          assert.equal(await client.page.locator("#" + id + " output").textContent(), status);
        }
        assert.deepEqual(client.requests, ["missing"]);
        await client.page.locator("#interact").click();
        assert.equal(await client.page.locator("#interact").textContent(), "1");
      }),
    );
    completed.push("ssr-hydration", "request-isolation");
    await a.page.locator("#failed button").click();
    await a.page.locator("#failed b").getByText("pending", { exact: true }).waitFor();
    assert.equal(await a.page.locator("#offer b").textContent(), "on");
    a.retry.resolve();
    await a.page.locator("#failed b").getByText("on", { exact: true }).waitFor();
    assert.equal(await b.page.locator("#failed output").textContent(), "error");
    assert.deepEqual(a.requests, ["missing", "failed"]);
    assert.deepEqual(problems, []);
    completed.push("retry");
    return completed;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
