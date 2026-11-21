import server, { initializeXp } from "@frostme/xp/server";
import assert from "node:assert/strict";
import test from "node:test";

import { assignedSlugs, setupDatabase } from "../xp-journey/database.mjs";
import { startHosts } from "../xp-journey/hosts.mjs";
import { capture } from "./consumer.ts";

const experiment = "delivery-copy";
const testDestination = { key: "amplitude-shop", provider: "amplitude" };
const analytics = { destinations: [testDestination], mapIdentity: () => "shop-account-7" };

async function decision(transport, session) {
  const body =
    transport.protocol === "rest"
      ? { slug: experiment }
      : {
          query: "mutation Decide($slug: String!) { xpResolveCohort(slug: $slug) { slug } }",
          variables: { slug: experiment },
        };
  const response = await globalThis.fetch(transport.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session && { Authorization: "Bearer " + session }),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.errors, undefined);
  return (transport.protocol === "rest" ? result : result.data.xpResolveCohort).slug;
}

async function outbox(pool) {
  return (
    await pool.query("SELECT * FROM xp_analytics_deliveries ORDER BY event_id, destination_key")
  ).rows;
}

test("the existing schema serves decisions with analytics disabled and reports missing analytics storage on opt-in", async (t) => {
  const { pool, close } = await setupDatabase("base");
  t.after(close);
  const runtime = await initializeXp({ connection: pool });
  assert.match(await runtime.getGroup("shopper", experiment), /^delivery-copy_/);
  assert.equal(
    (await pool.query("SELECT to_regclass('xp_analytics_deliveries') AS table_name")).rows[0]
      .table_name,
    null,
  );
  await assert.rejects(initializeXp({ connection: pool, analytics }), /analytics/i);
  await assert.rejects(server(pool, { analytics }).checkAnalyticsStorage(), /analytics/i);
});

test(
  "REST, GraphQL, sticky reads, races and leave/rejoin use only committed membership inserts",
  { timeout: 30_000 },
  async (t) => {
    const { pool, close } = await setupDatabase();
    t.after(close);
    const runtime = server(pool, { analytics });
    await runtime.checkAnalyticsStorage();
    await initializeXp({ connection: pool }); // Seed once, without capture.
    const hosts = await startHosts(runtime);
    try {
      const [rest, graphql] = hosts.transports;
      const restSlug = await decision(rest, "session-1");
      assert.match(restSlug, /^delivery-copy_/);
      assert.equal(await decision(graphql, "session-1"), restSlug);
      const graphSlug = await decision(graphql, "session-2");
      assert.deepEqual(await assignedSlugs(pool, "alice"), [graphSlug]);
      assert.equal(await decision(rest), null);
      assert.equal(await decision(graphql, "unregistered-session"), null);
      await runtime.pauseExperiment(experiment);
      assert.equal(await decision(graphql, "session-3"), null);
      await runtime.resumeExperiment(experiment);
      const before = await outbox(pool);
      assert.equal(before.length, 2);
      assert.equal(new Set(before.map((row) => row.event_id)).size, 2);
      const [automatic, manual] = await Promise.allSettled([
        runtime.resolveCohort("bob", experiment),
        runtime.joinCohort("bob", experiment, experiment + "_short"),
      ]);
      assert.equal(automatic.status, "fulfilled");
      if (manual.status === "rejected")
        assert.equal(manual.reason.name, "DuplicateAssignmentError");
      assert.deepEqual(await assignedSlugs(pool, "bob"), [automatic.value.slug]);
      assert.equal((await outbox(pool)).length, 3);
      await runtime.leaveExperiment("shopper", experiment);
      await runtime.joinCohort("shopper", experiment, restSlug);
      const after = await outbox(pool);
      assert.equal(after.length, 4);
      assert.equal(new Set(after.map((row) => row.event_id)).size, 4);
      await assert.rejects(runtime.joinCohort("shopper", experiment, restSlug), {
        name: "DuplicateAssignmentError",
      });
      const [{ id }] = (
        await pool.query("SELECT id FROM experiments WHERE slug = $1", [experiment])
      ).rows;
      await runtime.removeExperiment(id);
      assert.deepEqual(await outbox(pool), after);
    } finally {
      await hosts.close();
    }
  },
);

test("off assignment persists, a pinned off winner does not assign, and a manual join still commits", async (t) => {
  const { pool, close } = await setupDatabase();
  t.after(close);
  const runtime = await initializeXp({ connection: pool, analytics });
  const on = await runtime.viewCohort("checkout-banner_on");
  const off = await runtime.viewCohort("checkout-banner_off");
  // Baseline bucketing is uniform. Leave a single eligible cohort for a deterministic off decision.
  await runtime.removeCohort(on.id);
  assert.deepEqual(await runtime.resolveCohort("shopper", "checkout-banner"), { slug: null });
  assert.equal(await runtime.getGroup("shopper", "checkout-banner"), "checkout-banner_off");
  await runtime.finalizeExperiment(off.experiment_id, off.id);
  assert.deepEqual(await runtime.resolveCohort("alice", "checkout-banner"), { slug: null });
  assert.equal((await outbox(pool)).length, 1);
  await runtime.joinCohort("alice", "checkout-banner", off.slug);
  assert.equal((await outbox(pool)).length, 2);
});

test("capture failures roll back membership, skipped destinations commit, and identities stay destination specific", async (t) => {
  const { pool, close } = await setupDatabase();
  t.after(close);
  const scoped = (mapIdentity) =>
    initializeXp({ connection: pool, analytics: { ...capture, mapIdentity } });
  const skipped = await scoped(() => null);
  await skipped.getGroup("bob", experiment);
  assert.equal((await assignedSlugs(pool, "bob")).length, 1);
  assert.equal((await outbox(pool)).length, 0);
  const broken = await scoped(() => {
    throw new Error("fixture mapper failure");
  });
  await assert.rejects(broken.resolveCohort("shopper", experiment));
  assert.deepEqual(await assignedSlugs(pool, "shopper"), []);
  // Force an error in a destination insert after the transaction has already inserted the membership.
  await pool.query(
    "ALTER TABLE xp_analytics_deliveries ADD CONSTRAINT fixture_decline CHECK (destination_key <> 'segment-shop')",
  );
  const mapped = await scoped(({ destination }) =>
    destination.provider === "heap" ? null : "subject-" + destination.key,
  );
  await assert.rejects(mapped.getGroup("shopper", experiment));
  assert.deepEqual(await assignedSlugs(pool, "shopper"), []);
  assert.deepEqual(await outbox(pool), []);
  await pool.query("ALTER TABLE xp_analytics_deliveries DROP CONSTRAINT fixture_decline");
  await mapped.getGroup("shopper", experiment);
  const rows = await outbox(pool);
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.event_id)).size, 1);
  for (const row of rows) {
    assert.equal(row.subject_id, "subject-" + row.destination_key);
    assert.doesNotMatch(JSON.stringify(row), /shopper|heap-shop/);
    assert.equal(Object.hasOwn(row, "user_id"), false);
  }
});
