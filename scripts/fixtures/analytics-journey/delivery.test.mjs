import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { initializeXp } from "@frostme/xp/server";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { setupDatabase } from "../xp-journey/database.mjs";
import { createWarehouseAdaptor, startShop, startWorker } from "./consumer.ts";
import { checkReceipts, startReceivers } from "./receivers.mjs";

function processWorker(t, pool, options) {
  const child = fork(new URL("./worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    execArgv: [],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const messages = new Set();
  child.on("message", ({ type }) => messages.add(type));
  const connection = {};
  for (const key of ["connectionString", "host", "port", "user", "password", "database", "options"])
    connection[key] = pool.options[key];
  child.send({ connection, ...options });
  return {
    async waitFor(type) {
      await until(async () => {
        assert.ok(
          child.exitCode === null && child.signalCode === null,
          "worker exited before " + type,
        );
        return messages.has(type);
      }, "worker " + type);
    },
    async stop(signal) {
      child.kill(signal);
      return exited;
    },
    exited,
  };
}

async function until(predicate, description) {
  const end = Date.now() + 30_000;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for " + description);
}

test(
  "six installed adaptors deliver after downtime and recover a worker killed between HTTP acceptance and acknowledgment",
  { timeout: 90_000 },
  async (t) => {
    const { pool, close } = await setupDatabase();
    t.after(close);
    const { origins, attempts, repair } = await startReceivers(t);
    const shop = await startShop(pool);
    const empty = processWorker(t, pool, { origins, action: "drain" });
    assert.deepEqual(await empty.exited, { code: 0, signal: null });
    const { slug } = await shop.resolveCohort("shopper", "delivery-copy");
    assert.match(slug, /^delivery-copy_/);
    const read = async () => (await pool.query("SELECT * FROM xp_analytics_deliveries")).rows;
    const queued = await read();
    assert.equal(queued.length, 6);
    assert.equal(new Set(queued.map((r) => r.event_id)).size, 1);
    assert.ok(queued.every((row) => row.state === "pending"));
    assert.ok(Object.values(attempts).every((requests) => requests.length === 0));

    const crashed = processWorker(t, pool, {
      origins,
      only: "amplitude",
      crashAfterAcceptance: true,
      action: "drain",
    });
    const exit = await crashed.exited;
    const leased = (await read()).find((row) => row.provider === "amplitude");
    assert.deepEqual(
      exit,
      { code: null, signal: "SIGKILL" },
      `Amplitude crash fixture: ${leased.state}, ${leased.failure_reason}, ${attempts.amplitude.length} HTTP receipts`,
    );
    assert.equal(attempts.amplitude.length, 1);
    assert.equal(leased.state, "claimed");
    assert.equal((await read()).filter((r) => r.state === "pending").length, 5);

    // The event snapshot outlives both the member and its experiment.
    await shop.leaveExperiment("shopper", "delivery-copy");
    const cohort = await shop.viewCohort(slug);
    await shop.removeExperiment(cohort.experiment_id);
    const restarted = processWorker(t, pool, { origins, action: "run" });
    await restarted.waitFor("ready");
    await until(
      async () => (await read()).filter((r) => r.state === "delivered").length === 4,
      "healthy peers and expired lease recovery",
    );
    const rows = await read();
    const dead = rows.filter((r) => r.state === "failed");
    assert.deepEqual(Object.fromEntries(dead.map((row) => [row.provider, row.failure_reason])), {
      fullstory: "unauthorized",
      posthog: "invalid-event",
    });
    assert.equal(attempts.amplitude.length, 2);
    assert.equal(attempts.fullstory.length, 1);
    assert.equal(attempts.posthog.length, 1);

    const inspector = startWorker(pool, () => () => {
      throw new Error("inspection cannot send");
    });
    repair();
    for (const row of dead) {
      const diagnostics = JSON.stringify(await inspector.diagnostics(row.destination_key));
      assert.doesNotMatch(diagnostics, /external-|fixture secret|fixture-password|shopper/);
      await inspector.redrive(row.destination_key, row.event_id);
    }
    await until(
      async () => (await read()).every((row) => row.state === "delivered"),
      "re-driven destinations",
    );
    assert.deepEqual(await restarted.stop("SIGTERM"), { code: 0, signal: null });
    const event = JSON.parse(leased.event_json);
    assert.equal(event.id, leased.event_id);
    assert.equal(
      (await read()).find((row) => row.event_id === leased.event_id && row.provider === "amplitude")
        .attempts,
      2,
    );
    checkReceipts(attempts, event.id, event.occurredAt, slug);
    t.diagnostic(
      `Verified occurrence ${event.id} at ${event.occurredAt} in ${Object.entries(attempts)
        .map(([provider, receipts]) => `${provider} (${receipts.length} HTTP requests)`)
        .join(", ")}.`,
    );
    t.diagnostic(
      "Loopback HTTP verified six accepted deliveries, a repeated Amplitude send after SIGKILL, rate-limit and timeout recovery, and two terminal re-drives.",
    );
  },
);

test("a host-run custom adaptor accepts the committed event and the destination-specific subject", async (t) => {
  const { pool, close } = await setupDatabase();
  t.after(close);
  await pool.query(
    "CREATE TABLE warehouse_joins (event_id UUID PRIMARY KEY, subject_id TEXT NOT NULL, event JSONB NOT NULL)",
  );
  const destination = { key: "warehouse", provider: "custom:warehouse" };
  const shop = await initializeXp({
    connection: pool,
    analytics: { destinations: [destination], mapIdentity: () => "warehouse-shopper" },
  });
  const slug = await shop.getGroup("shopper", "delivery-copy");
  const adaptor = createWarehouseAdaptor(pool);
  const worker = createAnalyticsWorker({ connection: pool, adaptors: { warehouse: adaptor } });
  assert.equal((await worker.drainOnce()).delivered, 1);
  const {
    rows: [receipt],
  } = await pool.query("SELECT * FROM warehouse_joins");
  assert.equal(receipt.event_id, receipt.event.id);
  assert.equal(receipt.subject_id, "warehouse-shopper");
  assert.equal(receipt.event.cohortSlug, slug);
  assert.equal(receipt.event.source, "automatic");
  // Simulate the sink seeing the same occurrence after an interrupted local acknowledgment.
  await adaptor.deliver(
    { event: receipt.event, subjectId: receipt.subject_id },
    new globalThis.AbortController().signal,
    { attempt: 2 },
  );
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM warehouse_joins")).rows[0].n, "1");
});
