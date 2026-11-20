import { initializeXp } from "@frostme/xp/server";
import assert from "node:assert/strict";
import test from "node:test";

import { closeBrowser, mountClient } from "./browser.mjs";
import { assignedSlugs, setupDatabase } from "./database.mjs";
import { startHosts } from "./hosts.mjs";

const transportSlug = (transport, response) =>
  transport.protocol === "rest" ? response.body.slug : response.body.data.xpResolveCohort.slug;

async function renderOnce(transport, session, slug, status) {
  const client = mountClient(transport);
  try {
    await client.show(session, slug);
    const decision = await client.decision(status);
    assert.equal(client.requests.length, 1, "hook and gates share one request");
    return { ...decision, response: client.requests[0] };
  } finally {
    await client.close();
  }
}

test(
  "installed xp resolves React branches over authenticated HTTP and persists them in PostgreSQL",
  { timeout: 120000 },
  async (t) => {
    t.after(closeBrowser);
    const { pool, close } = await setupDatabase();
    t.after(close);
    const boot = () => initializeXp({ connection: pool });
    const first = await boot();
    assert.deepEqual(first.seedReport, {
      created: ["checkout-banner", "delivery-copy"],
      skipped: [],
    });
    const hosts = await startHosts(first);
    let sticky;
    try {
      for (const transport of hosts.transports) {
        await t.test(
          `${transport.name} renders the same assigned branch after a page reload`,
          async () => {
            for (let visit = 0; visit < 2; visit++) {
              const result = await renderOnce(transport, "session-1", "delivery-copy", "ready");
              assert.match(result.slug, /^delivery-copy_(control|short|detailed)$/);
              sticky ??= result.slug;
              assert.equal(result.slug, sticky);
              assert.equal(result.error, false);
              assert.equal(result.branch, sticky.split("_")[1]);
              assert.equal(result.response.status, 200);
              assert.equal(transportSlug(transport, result.response), sticky);
              assert.deepEqual(await assignedSlugs(pool, "shopper"), [sticky]);
            }
          },
        );
      }
    } finally {
      await hosts.close();
    }

    const runtime = await boot();
    assert.deepEqual(runtime.seedReport, {
      created: [],
      skipped: ["checkout-banner", "delivery-copy"],
    });
    await runtime.joinCohort("alice", "delivery-copy", "delivery-copy_short");
    await runtime.joinCohort("bob", "delivery-copy", "delivery-copy_control");
    const restarted = await startHosts(runtime);
    try {
      for (const transport of restarted.transports) {
        await t.test(
          `${transport.name} distinguishes both guest defaults from an unknown experiment after host restart`,
          async () => {
            const returning = await renderOnce(transport, "session-1", "delivery-copy", "ready");
            assert.equal(returning.slug, sticky);
            assert.deepEqual(await assignedSlugs(pool, "shopper"), [sticky]);
            const counts = async () =>
              (
                await pool.query(
                  "SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM user_cohorts) memberships",
                )
              ).rows[0];
            const before = await counts();
            for (const guest of [undefined, "unregistered-session"]) {
              const result = await renderOnce(transport, guest, "delivery-copy", "ready");
              assert.deepEqual(
                { slug: result.slug, branch: result.branch, error: result.error },
                { slug: null, branch: "default", error: false },
              );
              assert.equal(result.response.status, 200);
              assert.equal(transportSlug(transport, result.response), null);
            }
            const unknown = await renderOnce(transport, "session-1", "missing-experiment", "error");
            assert.equal(unknown.branch, "default");
            assert.equal(unknown.error, true);
            if (transport.protocol === "rest") assert.equal(unknown.response.status, 404);
            else assert.equal(unknown.response.body.errors[0].extensions.code, "NOT_FOUND");
            assert.deepEqual(await counts(), before);
          },
        );

        await t.test(
          `${transport.name} keeps account B visible after a late account A response`,
          async () => {
            const client = mountClient(transport, { holdSession: "session-2" });
            try {
              await client.show("session-2");
              await client.heldResponse;
              await client.show("session-3");
              const expected = { slug: "delivery-copy_control", error: false, branch: "control" };
              assert.deepEqual(await client.decision("ready"), expected);
              assert.deepEqual(
                client.requests.map((response) => transportSlug(transport, response)),
                ["delivery-copy_short", "delivery-copy_control"],
              );
              await client.releaseHeldRequest();
              assert.deepEqual(await client.decision("ready"), expected);
              assert.deepEqual(await assignedSlugs(pool, "alice"), ["delivery-copy_short"]);
              assert.deepEqual(await assignedSlugs(pool, "bob"), ["delivery-copy_control"]);
            } finally {
              await client.close();
            }
          },
        );
      }
    } finally {
      await restarted.close();
    }
  },
);
