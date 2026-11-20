import assert from "node:assert/strict";

import { withAstro } from "./server.mjs";

export default async function astro(ctx) {
  return withAstro(ctx, async (origin) => {
    if (ctx.journey) {
      await ctx.journey(origin);
      return [`${ctx.profile.id}-${ctx.profile.journey}`];
    }
    const staticHtml = await (await globalThis.fetch(origin + "/static/")).text();
    assert.match(staticHtml, /Public fallback/);
    assert.doesNotMatch(staticHtml, /Personalized/);
    for (const kind of ["rest", "graphql"]) {
      const response = await globalThis.fetch(origin + "/transport?kind=" + kind);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Transport resolved/);
      assert.match(html, /Repeated gate/);
      assert.doesNotMatch(html, /Transport failed/);
    }
    const early = await globalThis.fetch(origin + "/early");
    assert.equal(early.status, 403);
    assert.equal(await early.text(), "auth rejected");
    const browser = await ctx.chromium.launch();
    try {
      await Promise.all(
        ["session-1", "session-2"].map(async (identity, i) => {
          const context = await browser.newContext({ javaScriptEnabled: false });
          try {
            await context.addCookies([{ name: "xp_session", value: identity, url: origin }]);
            const page = await context.newPage();
            const requests = [];
            const errors = [];
            page.on("request", (r) => requests.push(r.method()));
            page.on("pageerror", (error) => errors.push(error.message));
            const response = await page.goto(origin);
            assert.equal(response.status(), 200);
            assert.equal(response.headers()["cache-control"], "private, no-store");
            assert.equal(response.headers()["x-host-header"], "preserved");
            assert.equal(await page.locator("b").textContent(), i ? "two" : "one");
            assert.equal(await page.locator("i").count(), i ? 0 : 2);
            assert.equal(await page.locator("astro-island").count(), 0);
            assert.equal(
              (await page.getByText("Failed default", { exact: false }).count()) > 0,
              true,
            );
            assert.equal(
              (await page.getByText("Empty default", { exact: false }).count()) > 0,
              true,
            );
            const payload = JSON.parse(await page.locator("#preload").textContent());
            assert.deepEqual(payload, {
              initialAssignments: {
                "checkout-banner": `checkout-banner_${i ? "off" : "on"}`,
                empty: null,
              },
              initialErrors: ["failed"],
            });
            assert.doesNotMatch(
              await page.content(),
              /private host exception|session-[12]|Unselected/,
            );
            assert.ok(requests.every((method) => method === "GET"));
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        }),
      );
      return [
        "private-html",
        "concurrent-identities",
        "public-prerender",
        "lazy-slots",
        "server-transports",
      ];
    } finally {
      await browser.close();
    }
  });
}
