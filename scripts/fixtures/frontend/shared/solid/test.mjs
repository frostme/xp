import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkBrowser } from "./check.mjs";

export default async function test({ cwd, chromium, run, profile, journey }) {
  run("bun", ["run", "tsc", "--noEmit"]);
  run("bun", ["run", "vite", "build"]);
  run("bun", ["run", "vite", "build", "--ssr", "src/server.tsx", "--outDir", "server"]);
  const { documentFor } = await import(pathToFileURL(path.join(cwd, "server/server.js")));
  const shell = await readFile(path.join(cwd, "dist/index.html"), "utf8");
  const server = createServer(async (req, res) => {
    try {
      const url = new globalThis.URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/assets/")) {
        res.setHeader("content-type", "text/javascript");
        return res.end(await readFile(path.join(cwd, "dist/assets", path.basename(url.pathname))));
      }
      if (url.pathname === "/csr.html") {
        res.setHeader("content-type", "text/html");
        return res.end(await readFile(path.join(cwd, "dist/csr.html")));
      }
      const account = req.headers.cookie?.includes("fixture-account=alice") ? "alice" : "bob";
      res.setHeader("content-type", "text/html");
      res.setHeader("cache-control", "private, no-store");
      res.end(
        await documentFor(
          shell,
          account,
          url.pathname === "/journey" ? (url.searchParams.get("slug") ?? "delivery-copy") : null,
        ),
      );
    } catch (error) {
      globalThis.console.error(error);
      res.writeHead(500).end("SSR failure");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    if (journey) {
      await journey(origin, chromium);
      return [profile.id + "-" + profile.journey];
    }
    const browser = await chromium.launch();
    try {
      const stock = await browser.newPage();
      let requestCount = 0;
      await stock.route("**/xp", async (route) => {
        assert.deepEqual(route.request().postDataJSON(), { slug: "checkout-banner" });
        requestCount++;
        await route.fulfill({ json: { slug: "checkout-banner_on" } });
      });
      await stock.goto(origin + "/csr.html");
      await stock.getByText("New checkout offer", { exact: true }).waitFor();
      assert.equal(requestCount, 1);
      await checkBrowser({ browser, origin });
    } finally {
      await browser.close();
    }
    assert.ok(profile.cases.length);
    return [
      "patched-csr",
      "nested-scopes",
      "transports",
      "mixed-preload",
      "isolated-hydration",
      "retry",
      "reactive-slug",
    ];
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
