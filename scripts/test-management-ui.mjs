import { NotFoundError } from "@frostme/xp/server";
import { createXpManagementHandler } from "@frostme/xp/server/management";
import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { expect } from "playwright/test";

const basePath = "/shop/internal/experiments";
const slug = "checkout-copy";
const counts = [84, 5, 11];
const record = {
  id: "copy-1",
  name: "Checkout copy",
  slug,
  type: "multivariate",
  enabled: true,
  description: "Checkout wording",
  winner: null,
  rolloutPhase: "allocating",
  revision: 3,
  countsReadAt: "2026-11-21T09:00:00Z",
  cohorts: ["off", "detailed", "short"].map((name, index) => ({
    slug: slug + "_" + name,
    type: index === 0 ? "control" : "treatment",
    description: "",
    value: null,
    percentage: index === 0 ? 90 : 5,
    memberships: counts[index],
  })),
};
let countsAvailable = true;
let listCount = 0;
const service = {
  allowCreate: true,
  async list({ cursor }) {
    listCount++;
    // DynamoDB may advance a scan before it finds the first matching definition.
    return cursor ? { items: [record], nextCursor: null } : { items: [], nextCursor: "continue" };
  },
  async detail(requested, access) {
    if (requested !== slug) throw new NotFoundError("Unknown experiment");
    return {
      ...record,
      actions: access === "manage" ? ["adjust", "pause", "finalize"] : [],
      countsReadAt: countsAvailable ? record.countsReadAt : null,
      cohorts: record.cohorts.map((c) => ({
        ...c,
        memberships: countsAvailable ? c.memberships : null,
      })),
    };
  },
  async apply(_slug, revision, command) {
    assert.equal(revision, record.revision);
    assert.equal(command.type, "adjust");
    for (const { cohort, percentage } of command.allocation)
      record.cohorts.find((c) => c.slug === cohort).percentage = percentage;
    record.revision++;
  },
};
const server = createServer(
  createXpManagementHandler({
    runtime: { management: service },
    basePath,
    access(request) {
      return request.headers.role ?? "deny";
    },
  }),
).listen(0, "127.0.0.1");
let browser;
try {
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + basePath;
  browser = await chromium.launch();
  const output = process.env.XP_MANAGEMENT_UI_EVIDENCE;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [375, 768, 1024, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
      extraHTTPHeaders: { role: "manage" },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url + "/experiments/" + slug);
    const h1 = page.getByRole("heading", { level: 1, name: "Checkout copy" });
    await expect(h1).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Serving now" })).toBeVisible();
    const fits = () =>
      page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth);
    assert.ok(await fits(), "detail fits " + width);
    if (output && [375, 1440].includes(width))
      await page.screenshot({ path: join(output, "detail-" + width + ".png"), fullPage: true });
    const adjust = page.getByRole("link", { name: "Adjust split" });
    await adjust.focus();
    await page.keyboard.press("Enter");
    const off = page.getByLabel("Proposed percentage for off");
    await off.fill("80");
    await page.getByLabel("Proposed percentage for detailed").fill("15");
    await page.getByLabel("Proposed percentage for short").fill("5");
    const review = page.getByRole("button", { name: "Review split" });
    await review.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Review allocation" })).toBeFocused();
    assert.ok(await fits(), "confirmation fits " + width);
    if (output && [375, 1440].includes(width))
      await page.screenshot({ path: join(output, "review-" + width + ".png") });
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
    if (width === 1440) {
      await review.click();
      await page.route(
        "**/commands",
        (route) => route.fulfill({ status: 409, json: { error: "Concurrent edit" } }),
        { times: 1 },
      );
      record.revision++;
      await dialog.getByRole("button", { name: "Apply split" }).click();
      const refresh = dialog.getByRole("button", { name: "Review current values" });
      await expect(refresh).toBeFocused();
      await refresh.click();
      await expect(off).toHaveValue("80");
      await expect(dialog).toHaveCount(0);
      await review.click();
      await dialog.getByRole("button", { name: "Apply split" }).click();
      await expect(h1).toBeFocused();
      assert.equal(record.cohorts[0].percentage, 80);

      countsAvailable = false;
      await page.reload();
      const retry = page.getByRole("button", { name: "Retry counts" });
      await expect(retry).toBeVisible();
      await expect(page.getByRole("cell", { name: /Unavailable/ })).toHaveCount(3);
      countsAvailable = true;
      await retry.click();
      await expect(retry).toHaveCount(0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }

  const viewer = await browser.newPage({ extraHTTPHeaders: { role: "view" } });
  await viewer.goto(url + "/experiments/" + slug);
  await expect(viewer.getByRole("heading", { name: "Serving now" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Adjust split" })).toHaveCount(0);
  await viewer.goto(url);
  await expect(viewer.getByRole("link", { name: "Create experiment" })).toHaveCount(0);
  await expect(viewer.getByRole("heading", { name: "Experiments", exact: true })).toBeVisible();
  const next = viewer.getByRole("button", { name: /next/i });
  await next.click();
  await expect(viewer.getByRole("link", { name: /Checkout copy/i }).first()).toBeVisible();
  assert.ok(listCount >= 2);
  await viewer.goto(url + "/experiments/unknown");
  await expect(viewer.getByText(/not found|unknown experiment/i).first()).toBeVisible();
  const denied = await browser.newPage();
  assert.equal((await denied.goto(url)).status(), 403);
  await expect(denied.getByRole("heading", { name: "Access denied" })).toBeVisible();
  console.log(
    "Management UI passed at 375, 768, 1024 and 1440 px, including focus, conflict recovery, permissions and count retry.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
