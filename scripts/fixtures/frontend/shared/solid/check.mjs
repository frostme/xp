import assert from "node:assert/strict";

export async function checkBrowser({ browser, origin, start = false }) {
  async function visit(account) {
    const context = await browser.newContext();
    await context.addCookies([{ name: "fixture-account", value: account, url: origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/hydration.{0,25}(error|mismatch|fail)/i.test(message.text()))
        errors.push(message.text());
    });
    const requests = [];
    let settleRetry;
    const retry = new Promise((resolve) => {
      settleRetry = resolve;
    });
    await page.route(/\/(xp|graphql)$/, async (route) => {
      const body = route.request().postDataJSON();
      const slug = body.variables?.slug ?? body.slug;
      requests.push(slug);
      if (route.request().url().endsWith("/graphql")) {
        assert.deepEqual(body.variables, { slug });
        assert.equal(body.operationName, "XpResolveCohort");
      } else assert.deepEqual(body, { slug });
      if (slug === "initial-error") await retry;
      const value = { slug: slug + "_on" };
      await route.fulfill({ json: body.variables ? { data: { xpResolveCohort: value } } : value });
    });
    const response = await page.goto(origin);
    assert.ok(response.ok());
    assert.match(response.headers()["cache-control"], /private.*no-store/);
    const html = await response.text();
    assert.match(html, /data-case="initial-error"/);
    const staticPage = await context.newPage();
    await staticPage.route("**/*", (route) =>
      route.request().resourceType() === "script" ? route.abort() : route.continue(),
    );
    await staticPage.goto(origin);
    const section = (page, slug) => page.locator('[data-case="' + slug + '"]');
    for (const [slug, status, branch] of [
      ["checkout-banner", "ready", account === "alice" ? "on" : "default"],
      ["explicit-null", "ready", "default"],
      ["initial-error", "error", "default"],
    ]) {
      for (const view of [staticPage, page]) {
        assert.equal(await section(view, slug).locator("[data-xp-status]").textContent(), status);
        assert.equal(await section(view, slug).locator("[data-xp-branch]").innerText(), branch);
      }
    }
    assert.equal(
      await section(staticPage, "missing-preload").locator("[data-xp-status]").innerText(),
      "loading",
    );
    await section(page, "missing-preload").getByText("ready", { exact: true }).waitFor();
    assert.deepEqual(requests, ["missing-preload"]);
    await section(page, "initial-error").getByRole("button").click();
    await section(page, "initial-error").locator("[data-loading]").waitFor();
    assert.equal(
      await section(page, "checkout-banner").locator("[data-xp-branch]").innerText(),
      account === "alice" ? "on" : "default",
    );
    settleRetry();
    await section(page, "initial-error").getByText("on", { exact: true }).waitFor();
    assert.deepEqual(requests, ["missing-preload", "initial-error"]);
    await page.locator("[data-retarget]").click();
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('[data-case="explicit-null"]').length === 2,
    );
    assert.deepEqual(requests, ["missing-preload", "initial-error"]);
    await page.locator("[data-controls]").click();
    await page.waitForFunction(
      () => globalThis.document.documentElement.dataset.requestSlug === "native-test",
    );
    await page.locator("[data-rest]").click();
    const native = section(page, "native-test");
    await native.getByText("on", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-duplicate]").count(), 2);
    await page.locator("[data-obsolete]").click();
    assert.equal(await page.locator("html").getAttribute("data-aborted"), "yes");
    assert.equal(await native.locator("[data-xp-branch]").innerText(), "on");
    await page.locator("[data-graphql]").click();
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector('[data-case="native-test"] [data-xp-status]')
          ?.textContent === "ready",
    );
    assert.deepEqual(requests, ["missing-preload", "initial-error", "native-test", "native-test"]);
    if (start) {
      await page.getByRole("link", { name: "Next experiment" }).click();
      await page.getByText("Second experiment route", { exact: true }).waitFor();
      assert.equal(new globalThis.URL(page.url()).pathname, "/next");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await Promise.all([visit("alice"), visit("bob")]);
}
