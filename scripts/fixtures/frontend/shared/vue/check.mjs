import assert from "node:assert/strict";

export async function checkBrowser({ chromium, origin, nuxt }) {
  const browser = await chromium.launch();
  try {
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    await contexts[1].addCookies([{ name: "variant", value: "b", url: origin }]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const errors = [];
    const requests = [[], []];
    const releases = [];
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (/hydration|mismatch/i.test(message.text())) errors.push(message.text());
      });
      await page.route("**/xp", async (route) => {
        const { slug } = route.request().postDataJSON();
        requests[index].push(slug);
        if (slug === "failed")
          await new Promise((resume) => {
            releases[index] = resume;
          });
        await route.fulfill({ json: { slug: slug + "_on" } });
      });
    }
    // Inspect response markup before Chromium can adopt or repair it during hydration.
    const documents = await Promise.all(contexts.map((context) => context.request.get(origin)));
    for (const [index, response] of documents.entries()) {
      assert.match(response.headers()["cache-control"], /private, no-store/);
      const markup = await response.text();
      assert.doesNotMatch(markup, /private failure detail/);
      function body(id) {
        const section = markup.match(new RegExp('<section id="' + id + '">([\\s\\S]*?)</section>'));
        assert.ok(section, id + " is present in SSR");
        return section[1];
      }
      assert.match(
        body("initial"),
        new RegExp("data-xp-branch[^>]*>" + (index ? "off" : "on") + "<"),
      );
      for (const [id, status] of [
        ["initial", "ready"],
        ["guest", "ready"],
        ["failed", "error"],
        ["missing", "loading"],
      ]) {
        assert.match(body(id), new RegExp("data-xp-status[^>]*>" + status + "<"));
      }
      for (const id of ["guest", "failed"]) assert.match(body(id), /data-xp-branch[^>]*>default</);
      assert.match(body("missing"), /pending/);
    }
    await Promise.all(pages.map((page) => page.goto(origin)));
    for (const [index, page] of pages.entries()) {
      const branch = (id) => page.locator("#" + id + " [data-xp-branch]");
      const status = (id) => page.locator("#" + id + " [data-xp-status]");
      await branch("missing").waitFor();
      assert.deepEqual(requests[index], ["missing"]);
      assert.equal(await branch("initial").innerText(), index ? "off" : "on");
      assert.equal(await branch("guest").innerText(), "default");
      assert.equal(await branch("failed").innerText(), "default");
      assert.equal(await status("failed").innerText(), "error");
      await page.locator("#failed [data-retry]").click();
      await page.locator("#failed i").waitFor();
      assert.equal(await status("failed").innerText(), "loading");
      assert.equal(await branch("initial").innerText(), index ? "off" : "on");
      const deadline = Date.now() + 10_000;
      while (!releases[index] && Date.now() < deadline) await page.waitForTimeout(5);
      assert.ok(releases[index], "Retry reached the browser decision endpoint");
      releases[index]();
      await branch("failed").waitFor();
      assert.equal(await branch("failed").innerText(), "on");
      assert.deepEqual(requests[index], ["missing", "failed"]);
      await page.locator("#retarget").click();
      assert.equal(await branch("reactive").innerText(), "default");
      assert.equal(await page.locator("#standalone").count(), index ? 0 : 1);
      if (nuxt && index === 0) {
        await page.evaluate(() => {
          globalThis.__xpNavigation = true;
        });
        await page.locator("#navigate").click();
        await page.locator("#other").waitFor();
        assert.equal(await page.evaluate(() => globalThis.__xpNavigation), true);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
