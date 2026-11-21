import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { expect } from "playwright/test";

import {
  button,
  capture,
  checkWidths,
  link,
  proposed,
  reviewSplit,
  setAvailability,
  submitCommand,
} from "./browser.mjs";
import { setupDatabase } from "./database.mjs";
import { basePath, slug, startHost, storedMembers } from "./host.mjs";

const off = slug + "_off";
const detailed = slug + "_detailed";
const short = slug + "_short";
const experimentPath = `/api/experiments/${slug}`;
const urlFor = (host, target = slug) => host.origin + basePath + "/experiments/" + target;
const newDefinition = { slug, cohorts: ["short", "detailed"] };
const publicDefault = { slug: null };

async function assertCounts(host, values) {
  const { cohorts, countsReadAt } = await host.detail();
  assert.ok(Number.isFinite(Date.parse(countsReadAt)));
  assert.deepEqual(
    Object.fromEntries(cohorts.map(({ slug, memberships }) => [slug, memberships])),
    {
      [off]: values[0],
      [short]: values[1],
      [detailed]: values[2],
    },
  );
}

test(
  "the installed management page controls persistent PostgreSQL delivery through host restarts",
  { timeout: 240000 },
  async (t) => {
    const database = await setupDatabase();
    const { pool } = database;
    let host;
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await host?.close();
        } finally {
          await database.close();
        }
      }
    });
    browser = await chromium.launch();
    host = await startHost(pool, false);
    assert.deepEqual(host.runtime.seedReport, {
      created: ["legacy-color", "summer-promo"],
      skipped: [],
    });
    assert.equal((await host.request("deny", "")).status, 403);
    assert.equal((await host.request("deny", "/api/experiments")).status, 403);
    assert.equal(
      await (await globalThis.fetch(host.origin + basePath + "-health")).text(),
      "host is healthy",
    );
    assert.equal(
      (await host.request("manage", "/api/experiments", { body: newDefinition })).status,
      403,
    );
    const seededPage = await host.open(browser, "manage");
    await seededPage.goto(host.origin + basePath);
    await expect(seededPage.getByText("Summer promo", { exact: true }).first()).toBeVisible();
    await expect(link(seededPage, "Create experiment")).toHaveCount(0);
    await seededPage.goto(urlFor(host, "summer-promo"));
    await link(seededPage, "Launch rollout").click();
    const seedReview = await reviewSplit(seededPage, { off: 0, offer: 100 });
    await submitCommand(seededPage, button(seedReview, "Launch rollout"));
    assert.equal((await host.detail("summer-promo")).rolloutPhase, "allocating");
    await host.runtime.joinCohort("alice", "legacy-color", "legacy-color_off");
    assert.deepEqual(await host.decision("a", "legacy-color"), { slug: "legacy-color_off" });
    await seededPage.context().close();
    await host.close();
    host = undefined;

    host = await startHost(pool, true);
    assert.deepEqual(host.runtime.seedReport, {
      created: [],
      skipped: ["legacy-color", "summer-promo"],
    });
    const page = await host.open(browser, "manage");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(host.origin + basePath);
    await expect(link(page, "Create experiment")).toBeVisible();
    await capture(page, "directory-desktop");
    await link(page, "Create experiment").click();
    await page.getByLabel("Experiment slug").fill(slug);
    await page.getByLabel(/Treatments/).fill("short, detailed");
    await button(page, "Create experiment").click();
    await expect(page).toHaveURL(urlFor(host));
    await expect(link(page, "Launch rollout")).toBeVisible();
    const initial = await host.detail();
    assert.equal(initial.enabled, true);
    assert.equal(initial.winner, off);
    assert.equal(initial.rolloutPhase, "awaiting-launch");
    const view = await host.open(browser, "view");
    await view.goto(urlFor(host));
    await expect(view.getByText("View only", { exact: true }).first()).toBeVisible();
    await expect(link(view, "Launch rollout")).toHaveCount(0);
    await expect(button(view, "Pause serving")).toHaveCount(0);
    assert.equal(
      (
        await host.request("view", experimentPath + "/commands", {
          tag: initial.tag,
          body: { type: "pause" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await host.request("view", "/api/experiments", { body: newDefinition })).status,
      403,
    );
    const response = await host.request("manage", experimentPath);
    assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    assert.deepEqual(await host.decision("a"), publicDefault);
    assert.deepEqual(await host.decision(undefined), publicDefault);
    assert.deepEqual(await storedMembers(pool), []);
    await assertCounts(host, [0, 0, 0]);

    await link(page, "Launch rollout").click();
    await proposed(page, "off").fill("49");
    await proposed(page, "short").fill("50");
    await button(page, "Review split").click();
    await expect(page.getByRole("alert").filter({ hasText: /100/ }).first()).toBeVisible();
    await expect(proposed(page, "off")).toHaveValue("49");
    let review = await reviewSplit(page, { off: 50, short: 50, detailed: 0 });
    await expect(review.getByRole("heading", { name: "Review allocation" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(button(page, "Review split")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(review).toBeVisible();
    await checkWidths(page, "review-split");
    await submitCommand(page, button(review, "Launch rollout"));
    assert.deepEqual(await host.decision("a", slug, 0.4999), publicDefault);
    assert.deepEqual(await host.decision("b", slug, 0.5), { slug: short });
    assert.deepEqual(await host.decision("a", slug, 0.99), publicDefault);
    assert.deepEqual(await host.decision("b", slug, 0), { slug: short });
    assert.deepEqual(await storedMembers(pool), [
      ["alice", off],
      ["bob", short],
    ]);
    await assertCounts(host, [1, 1, 0]);
    await page.reload();
    await expect(link(page, "Adjust split")).toBeVisible();
    for (const [name, count] of [
      ["off", 1],
      ["short", 1],
      ["detailed", 0],
    ]) {
      const row = page
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${name} `) }) });
      await expect(row.getByRole("cell").last()).toHaveText(new RegExp(`${count}$`));
    }
    await checkWidths(page, "allocating-detail");

    await link(page, "Adjust split").click();
    review = await reviewSplit(page, { off: 0, short: 0, detailed: 100 });
    await page.route(
      "**" + experimentPath + "/commands",
      (route) => route.fulfill({ status: 503, json: { error: "Try again." } }),
      { times: 1 },
    );
    await submitCommand(page, button(review, "Apply split"), 503);
    await expect(proposed(page, "detailed")).toHaveValue("100");
    await expect(review.getByRole("alert")).toContainText("Your proposal is still here");
    const competing = await host.request("manage", experimentPath + "/commands", {
      tag: (await host.detail()).tag,
      body: {
        type: "adjust",
        allocation: [
          { cohort: off, percentage: 2 },
          { cohort: short, percentage: 98 },
          { cohort: detailed, percentage: 0 },
        ],
      },
    });
    assert.equal(competing.status, 200, await competing.text());
    await submitCommand(page, button(review, "Apply split"), 409);
    await button(review, "Review current values").click();
    await expect(review).toHaveCount(0);
    await expect(proposed(page, "detailed")).toHaveValue("100");
    await button(page, "Review split").click();
    await expect(review).toContainText("98%");
    await submitCommand(page, button(review, "Apply split"));
    assert.deepEqual(await host.decision("a"), publicDefault);
    assert.deepEqual(await host.decision("b"), { slug: short });
    assert.deepEqual(await host.decision("s"), { slug: detailed });
    await assertCounts(host, [1, 1, 1]);
    const stale = await host.request("manage", experimentPath + "/commands", {
      tag: initial.tag,
      body: { type: "pause" },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).refresh, basePath + experimentPath);
    await setAvailability(page, "Pause serving");
    assert.deepEqual(await host.decision("b"), publicDefault);
    await setAvailability(page, "Resume serving");
    assert.deepEqual(await host.decision("b"), { slug: short });
    await button(page, "Select winner").click();
    const winnerDialog = page.getByRole("dialog");
    await winnerDialog.getByLabel("Winning cohort").selectOption(off);
    await submitCommand(page, button(winnerDialog, "Select off as winner"));
    assert.deepEqual(await host.decision("b"), publicDefault);
    assert.equal((await host.detail()).winner, off);
    await assertCounts(host, [1, 1, 1]);
    assert.deepEqual(errors, []);
    await page.context().close();
    await view.context().close();
    await host.close();
    host = undefined;

    host = await startHost(pool, true);
    const persisted = await host.detail();
    assert.equal(persisted.rolloutPhase, "winner-selected");
    assert.equal(persisted.winner, off);
    assert.deepEqual(await host.decision("s"), publicDefault);
    assert.deepEqual(await host.decision("a", "legacy-color"), { slug: "legacy-color_off" });
    assert.equal((await host.detail("summer-promo")).rolloutPhase, "allocating");
    assert.deepEqual(await storedMembers(pool), [
      ["alice", off],
      ["bob", short],
      ["shopper", detailed],
    ]);
    await pool.query("INSERT INTO users (id) VALUES ('sam')");
    await host.runtime.joinCohort("sam", slug, short);
    await assertCounts(host, [1, 2, 1]);
    await host.runtime.leaveExperiment("sam", slug);
    await assertCounts(host, [1, 1, 1]);
    await host.runtime.joinCohort("sam", slug, detailed);
    await assertCounts(host, [1, 1, 2]);
    assert.deepEqual(await storedMembers(pool), [
      ["alice", off],
      ["bob", short],
      ["sam", detailed],
      ["shopper", detailed],
    ]);
  },
);
