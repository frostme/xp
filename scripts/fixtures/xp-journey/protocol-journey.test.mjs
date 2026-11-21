import { createGraphQLLoader, createRestLoader } from "@frostme/xp/client";
import { initializeXp } from "@frostme/xp/server";
import { createXpSoapHandler } from "@frostme/xp/server/soap";
import { Client, credentials, Metadata } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  pageOrigin,
  envoyOrigin,
  startDirectHosts,
  startNativeHost,
} from "../protocol-browser/hosts.mjs";
import { startEnvoy } from "../protocol-browser/proxy.mjs";
import { runReactJourney } from "../protocol-browser/react-journey.mjs";
import { assignedSlugs, setupDatabase } from "./database.mjs";
import { startHosts } from "./hosts.mjs";
import { account, startRestMounts } from "./protocol-rest.mjs";

const experiment = "delivery-copy";
const names = [
  "Express",
  "Yoga",
  "Apollo",
  "Fastify",
  "Nest Express",
  "Nest Fastify",
  "native gRPC",
  "direct gRPC-Web",
  "Envoy gRPC-Web",
  "SOAP",
];

// All listeners must have reached the database-backed runtime before it can write
// the shopper's first assignment. Subsequent calls go straight through.
function raceFirstAssignment(runtime) {
  let arrivals = 0;
  const ready = Promise.withResolvers();
  return {
    driverKind: runtime.driverKind,
    async resolveCohort(id, slug) {
      if (id === "shopper" && arrivals < names.length) {
        arrivals++;
        if (arrivals === 1) {
          const timeout = globalThis.setTimeout(
            () =>
              ready.reject(new Error(`Only ${arrivals} transports reached the assignment race`)),
            15000,
          );
          ready.promise.then(
            () => globalThis.clearTimeout(timeout),
            () => globalThis.clearTimeout(timeout),
          );
        }
        if (arrivals === names.length) ready.resolve();
        await ready.promise;
      }
      return runtime.resolveCohort(id, slug);
    },
  };
}

function nativeLoader(client) {
  const schema = fileURLToPath(import.meta.resolve("@frostme/xp/proto/xp/v1/cohort.proto"));
  const method = loadSync(schema)["xp.v1.CohortService"].ResolveCohort;
  return (slug, session) => {
    const metadata = new Metadata();
    if (session) metadata.set("authorization", "Bearer " + session);
    return new Promise((resolve, reject) =>
      client.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        { slug },
        metadata,
        { deadline: Date.now() + 20000 },
        (error, response) => (error ? reject(error) : resolve(response.slug ?? null)),
      ),
    );
  };
}

function legacyLoader({ endpoint, protocol }) {
  const factory = protocol === "rest" ? createRestLoader : createGraphQLLoader;
  return (slug, session) => {
    const token = { shopper: "session-1", unregistered: "unregistered-session" }[session];
    return factory({ endpoint, headers: token ? { authorization: "Bearer " + token } : {} })(slug);
  };
}

function browserDecisions(page, slug) {
  return page.evaluate(async (slug) => {
    const client = new globalThis.URL("/page.js", globalThis.location.href);
    return (await import(client.href)).decisions(slug);
  }, slug);
}

async function waitForProxy(page) {
  const deadline = Date.now() + 30000;
  let proxy;
  do {
    const [direct, envoy, soap] = await browserDecisions(page, experiment);
    assert.deepEqual(direct, { value: null }, "guest on direct gRPC-Web");
    assert.deepEqual(soap, { value: null }, "guest on SOAP");
    if (Object.hasOwn(envoy, "value")) {
      assert.deepEqual(envoy, { value: null }, "guest through Envoy");
      return;
    }
    proxy = envoy;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail("Envoy did not reach native gRPC: " + proxy.error);
}

async function sessionCookie(page, session) {
  await page.context().clearCookies({ name: "session" });
  if (session)
    await page.context().addCookies([{ name: "session", value: session, url: pageOrigin }]);
}

test(
  "ten transports agree on the first assignment and its PostgreSQL membership",
  { timeout: 120000 },
  async (t) => {
    const cleanup = new globalThis.AsyncDisposableStack();
    try {
      const { pool, close } = await setupDatabase();
      cleanup.defer(close);
      const xp = await initializeXp({ connection: pool });
      const runtime = raceFirstAssignment(xp);
      const legacy = await startHosts(runtime);
      cleanup.defer(legacy.close);
      const rest = await startRestMounts(runtime);
      cleanup.defer(rest.close);
      cleanup.defer(await startNativeHost(runtime, { identity: account }));
      const soapPath = "/api/xp/soap";
      const soap = await createXpSoapHandler({
        runtime,
        path: soapPath,
        publicEndpoint: pageOrigin + soapPath,
      });
      cleanup.defer(
        await startDirectHosts(runtime, { identity: account, routes: { [soapPath]: soap } }),
      );
      cleanup.defer(await startEnvoy());
      const native = new Client("127.0.0.1:18183", credentials.createInsecure());
      cleanup.defer(() => native.close());
      const browser = await chromium.launch({
        executablePath: process.env.XP_CHROMIUM_EXECUTABLE_PATH,
      });
      cleanup.defer(() => browser.close());
      const page = await browser.newPage();
      await page.goto(pageOrigin);
      const counts = async () =>
        (
          await pool.query(
            "SELECT (SELECT COUNT(*)::int FROM users) users, (SELECT COUNT(*)::int FROM user_cohorts) memberships",
          )
        ).rows[0];
      assert.deepEqual(await counts(), { users: 3, memberships: 0 });
      await waitForProxy(page);

      const loaders = [...legacy.transports.map(legacyLoader), ...rest.load, nativeLoader(native)];
      async function decisions(session, slug = experiment) {
        await sessionCookie(page, session);
        const [node, web] = await Promise.all([
          Promise.allSettled(loaders.map((load) => load(slug, session))),
          browserDecisions(page, slug),
        ]);
        const results = [
          ...node.map((result) =>
            result.status === "fulfilled"
              ? { value: result.value }
              : { error: result.reason.message },
          ),
          ...web,
        ];
        assert.equal(results.length, names.length);
        return results;
      }
      function allEqual(results, slug) {
        for (const [i, result] of results.entries())
          assert.deepEqual(result, { value: slug }, names[i]);
      }

      const first = await decisions("shopper");
      const sticky = first[0].value;
      assert.match(sticky, /^delivery-copy_(short|control|detailed)$/, JSON.stringify(first));
      allEqual(first, sticky);
      allEqual(await decisions("shopper"), sticky);
      assert.deepEqual(await assignedSlugs(pool, "shopper"), [sticky]);
      const assigned = { users: 3, memberships: 1 };
      assert.deepEqual(await counts(), assigned);
      t.diagnostic(
        names.join(", ") + " all returned " + sticky + ". PostgreSQL has exactly one membership.",
      );

      for (const guest of [undefined, "unregistered"]) {
        allEqual(await decisions(guest), null);
        allEqual(await decisions(guest, "missing-experiment"), null);
        assert.deepEqual(await counts(), assigned);
      }
      await xp.pauseExperiment(experiment);
      allEqual(await decisions("shopper"), null);
      await xp.resumeExperiment(experiment);
      allEqual(await decisions("shopper"), sticky);
      const unknown = await decisions("shopper", "missing-experiment");
      for (const [i, result] of unknown.entries()) {
        assert.match(result.error, /404|GraphQL operation failed|not.found/i, names[i]);
      }
      assert.deepEqual(await assignedSlugs(pool, "shopper"), [sticky]);
      assert.deepEqual(await counts(), assigned);

      await xp.joinCohort("alice", experiment, "delivery-copy_short");
      await xp.joinCohort("bob", experiment, "delivery-copy_control");
      await runReactJourney(page, {
        directBase: "/api",
        proxyBase: envoyOrigin + "/api",
        soapEndpoint: soapPath,
      });
      assert.deepEqual(await assignedSlugs(pool, "alice"), ["delivery-copy_short"]);
      assert.deepEqual(await assignedSlugs(pool, "bob"), ["delivery-copy_control"]);
      assert.deepEqual(await counts(), { users: 3, memberships: 3 });
    } finally {
      await cleanup.disposeAsync();
    }
  },
);
