import assert from "node:assert/strict";
import { fork } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { setupDatabase } from "../xp-journey/database.mjs";
import { startShop, startWorker } from "./consumer.ts";
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
  const end = Date.now() + 15_000;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for " + description);
}

test(
  "six installed adaptors deliver after downtime and recover a worker killed between HTTP acceptance and acknowledgment",
  { timeout: 60_000 },
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
      suspendAfterAcceptance: true,
      action: "drain",
    });
    await crashed.waitFor("accepted");
    const leased = (await read()).find((row) => row.provider === "amplitude");
    assert.equal(leased.state, "claimed");
    assert.equal((await read()).filter((r) => r.state === "pending").length, 5);
    assert.deepEqual(await crashed.stop("SIGKILL"), { code: null, signal: "SIGKILL" });

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
    assert.deepEqual(dead.map((r) => r.provider).sort(), ["fullstory", "posthog"]);
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
      "Loopback HTTP verified six accepted deliveries, a repeated Amplitude send after SIGKILL, rate-limit and timeout recovery, and two terminal re-drives.",
    );
  },
);
