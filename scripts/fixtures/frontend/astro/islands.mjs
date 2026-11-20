import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { withAstro } from "./server.mjs";

export default async function islands(ctx) {
  return withAstro(ctx, async (origin) => {
    const inputs = JSON.parse(await readFile(path.join(ctx.cwd, "browser-inputs.json"), "utf8"));
    assert.ok(
      inputs.some((id) => id.includes("XpIsland.")),
      "bundler compiled generated island",
    );
    const forbidden = [
      "node:",
      "/dist/server/",
      "/dist/adaptors/",
      "/dist/cli/",
      "/node_modules/pg/",
      "/node_modules/ink/",
    ];
    const unrelated = { react: "react", vue: "vue", svelte: "svelte", solid: "solid-js" };
    for (const [key, pkg] of Object.entries(unrelated))
      if (key !== ctx.profile.island) forbidden.push("/node_modules/" + pkg + "/");
    for (const id of inputs)
      assert.ok(
        !forbidden.some((module) => id.startsWith("node:") || id.includes(module)),
        "Unexpected browser input: " + id,
      );
    const browser = await ctx.chromium.launch();
    try {
      await Promise.all(
        ["session-1", "session-2"].map(async (identity, i) => {
          const context = await browser.newContext();
          try {
            await context.addCookies([{ name: "xp_session", value: identity, url: origin }]);
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(e.message));
            page.on("console", (m) => {
              if (/hydration|mismatch/i.test(m.text())) errors.push(m.text());
            });
            const pending = [];
            const requests = [];
            await page.route("**/xp", async (route) => {
              const body = route.request().postDataJSON();
              assert.deepEqual(Object.keys(body), ["slug"]);
              requests.push(body.slug);
              const { promise, resolve } = Promise.withResolvers();
              pending.push(resolve);
              await promise;
              await route.fulfill({ json: { slug: body.slug + "_on" } });
            });
            const response = await page.goto(origin + "/islands");
            assert.equal(response.status(), 200);
            assert.equal(response.headers()["cache-control"], "private, no-store");
            const markup = await response.text();
            const initial = await page.evaluate((html) => {
              const dom = new globalThis.DOMParser().parseFromString(html, "text/html");
              return [...dom.querySelectorAll("astro-island")].map((island) => ({
                props: island.getAttribute("props"),
                statuses: [...island.querySelectorAll("output")].map((n) => n.textContent),
                text: island.textContent,
              }));
            }, markup);
            assert.equal(initial.length, 2);
            const expected = i ? "Previous offer" : "New offer";
            for (const [j, html] of initial.entries()) {
              assert.deepEqual(html.statuses, ["ready", "ready", "error", "loading", "ready"]);
              assert.ok(html.text.includes(expected) && html.text.includes("Loading"));
              assert.ok(html.props.includes(j ? "side-b" : "side-a"));
              assert.ok(!html.props.includes(j ? "side-a" : "side-b"));
              assert.ok(
                !html.props.includes(identity) && !html.props.includes("private host exception"),
              );
            }
            await page.waitForFunction(
              () => globalThis.document.querySelectorAll("astro-island:not([ssr])").length === 2,
            );
            const groups = page.locator("astro-island");
            const article = (j, slug) =>
              groups.nth(j).getByRole("article", { name: slug, exact: true });
            const status = (j, slug) => article(j, slug).locator("output");
            for (const j of [0, 1]) {
              assert.equal(await status(j, "checkout-banner").textContent(), "ready");
              assert.ok((await article(j, "checkout-banner").textContent()).includes(expected));
              assert.equal(await status(j, "empty").textContent(), "ready");
              assert.equal(await status(j, "failed").textContent(), "error");
              assert.ok((await article(j, "failed").textContent()).includes("Current offer"));
            }
            await page.waitForFunction(
              () =>
                globalThis.document.querySelectorAll('article[aria-label="missing"] output')
                  .length === 2,
            );
            await waitCount(requests, 2);
            assert.deepEqual(requests, ["missing", "missing"]);
            for (const resolve of pending.splice(0)) resolve();
            for (const j of [0, 1])
              await article(j, "missing")
                .getByText("New offer", { exact: false })
                .first()
                .waitFor();
            for (const j of [0, 1]) {
              await article(j, "failed").getByRole("button").click();
              await waitCount(requests, 3 + j);
              assert.equal(await status(j, "failed").textContent(), "loading");
              assert.equal(await status(1 - j, "failed").textContent(), j ? "ready" : "error");
              assert.ok((await article(j, "checkout-banner").textContent()).includes(expected));
              pending.shift()();
              await article(j, "failed").getByText("New offer", { exact: false }).first().waitFor();
            }
            assert.deepEqual(requests, ["missing", "missing", "failed", "failed"]);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        }),
      );
      return ["private-island-html", "scoped-preload", "independent-hydration", "retry"];
    } finally {
      await browser.close();
    }
  });
}

async function waitCount(list, count) {
  const end = Date.now() + 10000;
  while (list.length < count && Date.now() < end)
    await new Promise((r) => globalThis.setTimeout(r, 10));
  assert.equal(list.length, count);
}
