import { test, expect } from "@playwright/test";
import { trackErrors, openApp, waitGate, decide } from "./helpers";

test("phone: full-screen approval card with portrait, diff snippet and spend", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 600, "phone layout only");
  const errors = trackErrors(page);
  await openApp(page);
  // sheet layout: office on top, bottom sheet with title + horizontal stepper
  await expect(page.locator(".mobile-bar")).toBeVisible();
  await expect(page.locator("#run-title")).toHaveText("Kopi Senja landing page");
  await expect(page.locator("#steps-h")).toBeVisible();
  await expect(page.locator("#steps")).toBeHidden();
  const office = await page.locator("#office").boundingBox();
  const sheet = await page.locator("#panel").boundingBox();
  expect(office!.y).toBeLessThan(sheet!.y);
  await page.locator("#run-btn").click();
  await waitGate(page, /PM wants to start/);
  await decide(page, "approve");
  const modal = await waitGate(page, /2 tests failing, fix before deploy\?/);
  const box = await modal.boundingBox();
  expect(box!.width).toBe(390);
  expect(box!.height).toBeGreaterThanOrEqual(844);
  await expect(modal.locator("img")).toHaveAttribute("alt", "Reviewer");
  await expect(modal.locator(".diff .del").first()).toContainText("css/styles.css");
  await expect(modal.locator(".diff .add").first()).toContainText("css/style.css");
  await expect(modal.locator(".so-far")).toContainText(/\$\d+\.\d\d so far/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const card = await modal.locator(".ma-card").boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(390);
  await decide(page, "approve");
  await expect(page.locator("#steps-h li.active .pip, #steps-h li.done").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: the top bar (Building, Files, Insights, Settings) fits without widening the page", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 600, "phone only");
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/?target=demo-hermes");
    await expect(page.locator('.bar-actions [data-building]')).toBeVisible();
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth, bar: Math.round(document.querySelector(".bar-actions")!.getBoundingClientRect().right) }));
    expect(w.doc).toBeLessThanOrEqual(width);
    expect(w.bar).toBeLessThanOrEqual(width);
  }
});
