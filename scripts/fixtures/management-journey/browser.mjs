import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { expect } from "playwright/test";

export const button = (surface, name) => surface.getByRole("button", { name, exact: true });
export const link = (surface, name) => surface.getByRole("link", { name, exact: true });
export const proposed = (page, name) =>
  page.getByLabel(`Proposed percentage for ${name}`, { exact: true });

export async function capture(page, name) {
  if (!process.env.XP_MANAGEMENT_EVIDENCE) return;
  await mkdir(process.env.XP_MANAGEMENT_EVIDENCE, { recursive: true });
  await page.screenshot({
    path: join(process.env.XP_MANAGEMENT_EVIDENCE, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
}

export async function checkWidths(page, name) {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    assert.ok(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      `${name} fits ${width}px`,
    );
    await capture(page, `${name}-${width}`);
  }
}

export async function reviewSplit(page, percentages) {
  for (const [cohort, value] of Object.entries(percentages))
    await proposed(page, cohort).fill(String(value));
  await button(page, "Review split").click();
  const dialog = page.getByRole("dialog", { name: "Review allocation" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function submitCommand(page, submit, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) => result.url().endsWith("/commands") && result.request().method() === "POST",
    ),
    submit.click(),
  ]);
  assert.equal(response.status(), status, await response.text());
}

export async function setAvailability(page, action) {
  await button(page, action).click();
  await submitCommand(page, button(page.getByRole("dialog"), action));
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
