import assert from "node:assert/strict";

// The calling fixture serves react.js at the page origin. Decisions travel
// through the installed adapters, including Envoy's native gRPC upstream.
export async function runReactJourney(page, { directBase, proxyBase, soapEndpoint }) {
  const session = async (value) => {
    const context = page.context();
    await context.clearCookies({ name: "session" });
    if (value) await context.addCookies([{ name: "session", value, url: page.url() }]);
  };
  const calls = [];
  const observe = (request) => {
    if (request.method() === "POST") calls.push(request.url());
  };
  const render = (loader, endpoint, sessionKey) =>
    page.evaluate(async (options) => (await import("/react.js")).showSession(options), {
      loader,
      endpoint,
      sessionKey,
    });
  const verify = async (key, status, slug, error, branch) => {
    const section = page.locator(`#react-journey [data-session="${key}"]`);
    await section.locator(`output[data-status="${status}"]`).waitFor({ state: "attached" });
    assert.equal(await section.locator("output").getAttribute("data-slug"), slug ?? "");
    assert.equal(await section.locator("output").getAttribute("data-error"), String(error));
    assert.deepEqual(await section.locator("strong").allTextContents(), [branch]);
  };

  page.on("request", observe);
  try {
    for (const [literal, endpoint] of [
      ["grpc-web", directBase],
      ["soap", soapEndpoint],
    ]) {
      await session();
      const before = calls.length;
      await render(literal, endpoint, literal + "-guest");
      await verify(literal + "-guest", "ready", null, false, "default");
      assert.equal(calls.length, before + 1, "one request shared by hook and gates");

      await session("denied");
      const key = literal + "-retry";
      await render(literal, endpoint, key);
      await verify(key, "error", null, true, "default");
      await session("alice");
      await page.locator("#react-journey button").click();
      await verify(key, "ready", "delivery-copy_short", false, "short");
    }

    await session("alice");
    // Arm the barrier and request in the same page evaluation. The response
    // has reached the real browser and decoded before B starts.
    const held = await page.evaluate(async (endpoint) => {
      const app = await import("/react.js");
      const result = app.holdNextResponse();
      app.showSession({ loader: "custom", endpoint, sessionKey: "alice" });
      return result;
    }, proxyBase);
    assert.equal(held, "delivery-copy_short");
    await session("bob");
    await render("custom", proxyBase, "bob");
    await verify("bob", "ready", "delivery-copy_control", false, "control");
    const aborted = await page.evaluate(async () => {
      const app = await import("/react.js");
      const cancelled = await app.releaseResponse();
      // Let pending asynchronous loader and React callbacks settle.
      await new Promise((resolve) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
      );
      return cancelled;
    });
    assert.equal(aborted, true, "React cancelled the obsolete session request");
    await verify("bob", "ready", "delivery-copy_control", false, "control");
  } finally {
    page.off("request", observe);
    await session();
  }
}
