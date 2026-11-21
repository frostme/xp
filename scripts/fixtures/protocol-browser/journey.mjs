import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { chromium } from "playwright";

import {
  directOrigin,
  envoyOrigin,
  pageOrigin,
  rpcPath,
  startDirectHosts,
  startNativeHost,
} from "./hosts.mjs";
import { checkPreflight, startEnvoy } from "./proxy.mjs";

const pending = Promise.withResolvers();
const release = Promise.withResolvers();
const runtime = {
  driverKind: "postgres",
  async resolveCohort(user, slug) {
    if (slug === "slow-decision") {
      pending.resolve();
      await release.promise;
    }
    if (slug === "failed") throw new Error("storage detail");
    return { slug: user ? `${slug}_${user === "bob" ? "control" : "short"}` : null };
  },
};

async function decision(page, options, slug = "delivery-copy") {
  return page.evaluate(
    async ({ options, slug }) => {
      let wire;
      const load = globalThis.createGrpcWebLoader({
        ...options,
        fetch: async (url, init) => {
          const response = await globalThis.fetch(url, init);
          wire = {
            status: response.status,
            grpcStatus: response.headers.get("grpc-status"),
            grpcMessage: response.headers.get("grpc-message"),
            cache: response.headers.get("cache-control"),
          };
          return response;
        },
      });
      try {
        return { slug: await load(slug), wire };
      } catch (error) {
        return { code: error.code, message: error.message, wire };
      }
    },
    { options, slug },
  );
}

async function exercise(page, experimentHost, sameOrigin = false) {
  await page.context().clearCookies();
  const options = { experimentHost, ...(sameOrigin ? {} : { credentials: "include" }) };
  const guest = await decision(page, options);
  assert.equal(guest.slug, null, JSON.stringify(guest));
  assert.equal(guest.wire.cache, "private, no-store");
  await page.context().addCookies([{ name: "session", value: "alice", url: pageOrigin }]);
  if (!sameOrigin) assert.equal((await decision(page, { experimentHost })).slug, null);
  const assigned = await decision(page, options);
  assert.equal(assigned.slug, "delivery-copy_short", JSON.stringify(assigned));
  assert.equal(assigned.wire.status, 200);
  const endpoint = experimentHost.replace(/\/$/, "") + rpcPath.slice(4);
  assert.equal(
    (await decision(page, { ...options, experimentHost: "/ignored", endpoint })).slug,
    assigned.slug,
  );
  const denied = await decision(page, { ...options, headers: { authorization: "Bearer denied" } });
  assert.equal(denied.code, 16, JSON.stringify(denied));
  assert.equal(denied.wire.status, 200);
  assert.equal(denied.wire.cache, "private, no-store");
  assert.equal(
    (await decision(page, { ...options, headers: { authorization: "Bearer forbidden" } })).code,
    7,
  );
  const failed = await decision(page, options, "failed");
  assert.equal(failed.code, 13);
  assert.equal(failed.wire.status, 200);
  assert.doesNotMatch(failed.message, /storage detail/);
  return denied;
}

// Supply deterministic malformed gRPC-Web bytes to the installed browser loader.
async function verifyWireValidation(page) {
  const messages = await page.evaluate(async () => {
    const frame = (flag, bytes) => [flag, 0, 0, 0, bytes.length, ...bytes];
    const encoder = new globalThis.TextEncoder();
    const trailer = frame(128, encoder.encode("grpc-status: 0\r\n"));
    const wrong = encoder.encode("other_short");
    const failures = [];
    for (const body of [
      [...frame(0, [10, 0]), ...trailer],
      [...frame(0, [10, wrong.length, ...wrong]), ...trailer],
      frame(0, []),
      [],
    ]) {
      const load = globalThis.createGrpcWebLoader({
        fetch: async () =>
          new globalThis.Response(new Uint8Array(body), {
            headers: { "content-type": "application/grpc-web+proto" },
          }),
      });
      try {
        await load("delivery-copy");
        failures.push(null);
      } catch (error) {
        failures.push(error.message);
      }
    }
    return failures;
  });
  assert.match(messages[0], /qualified cohort slug/);
  assert.match(messages[1], /qualified cohort slug/);
  assert.ok(messages[2] && messages[3]);
  await assert.rejects(decision(page, { endpoint: "/api/ResolveCohort" }), /ending in/);
}

await using cleanup = new AsyncDisposableStack();
const closeDirect = await startDirectHosts(runtime);
cleanup.defer(closeDirect);
const browser = await chromium.launch({
  executablePath: process.env.XP_CHROMIUM_EXECUTABLE_PATH,
});
cleanup.defer(() => browser.close());
const page = await browser.newPage();
await page.goto(pageOrigin);
await page.waitForFunction(() => typeof globalThis.createGrpcWebLoader === "function");
await exercise(page, "/api", true);
await checkPreflight(directOrigin);
const directDenial = await exercise(page, directOrigin + "/api");
assert.equal(directDenial.wire.grpcStatus, "16");
assert.equal(decodeURIComponent(directDenial.wire.grpcMessage), "Invalid session");
const sibling = await page.request.get(directOrigin + "/sibling");
assert.equal(sibling.status(), 200);
assert.equal(await sibling.text(), "host-owned");
await verifyWireValidation(page);

const aborted = page.evaluate(async () => {
  const controller = new globalThis.AbortController();
  Object.assign(globalThis, { abortRpc: () => controller.abort() });
  try {
    await globalThis.createGrpcWebLoader({ experimentHost: "/api" })("slow-decision", {
      signal: controller.signal,
    });
  } catch (error) {
    return error.code;
  }
  return null;
});
try {
  await Promise.race([
    pending.promise,
    new Promise((_, reject) => {
      globalThis.setTimeout(() => reject(new Error("RPC did not reach runtime")), 5000).unref();
    }),
  ]);
  await page.evaluate(() => globalThis.abortRpc());
  assert.equal(await aborted, 1);
} finally {
  release.resolve();
}
console.log(
  "Chromium direct Node gRPC-Web passed, including trailers-only host denial and cancellation.",
);

cleanup.defer(await startNativeHost(runtime));
cleanup.defer(await startEnvoy());
await exercise(page, envoyOrigin + "/api");
console.log(
  "Chromium Envoy → HTTP/2 native gRPC passed, including credentialed preflight, cookies and RPC status.",
);
