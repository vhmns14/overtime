import { expect, type Page } from "@playwright/test";

export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1000) < 600;
export const gateSel = (page: Page) => (isMobile(page) ? "#mobile-approval" : "#approval");

/** Opens the app on a built-in-team demo by default (the first visit itself is "Watch my Hermes"). */
export async function openApp(page: Page, speed = 0.2, target: string | null = "kopi-senja") {
  await page.goto(`/?speed=${speed}${target ? `&target=${target}` : ""}`);
  await expect(page.locator("#run-btn")).toBeVisible();
  await expect(page.locator(".office-canvas")).toBeVisible();
}

export async function waitGate(page: Page, title: RegExp) {
  const g = page.locator(gateSel(page));
  await expect(g).toBeVisible({ timeout: 90_000 });
  await expect(g).toContainText(title);
  return g;
}

export async function decide(page: Page, act: "approve" | "reject" | "comment", comment?: string) {
  const g = page.locator(gateSel(page));
  if (comment) {
    if (!isMobile(page)) await g.locator('[data-act="toggle-comment"]').click();
    await g.locator(".comment input").fill(comment);
  }
  await g.locator(`[data-act="${act}"]`).click();
  await expect(g).toBeHidden();
}

export async function runDemoToEnd(page: Page) {
  await page.locator("#run-btn").click();
  await waitGate(page, /PM wants to start with 6 tickets/);
  await decide(page, "approve");
  await waitGate(page, /2 tests failing, fix before deploy/);
  await decide(page, "approve");
  await waitGate(page, /Ops wants to deploy 4 files to preview/);
  await decide(page, "approve");
  await expect(page.locator("#result")).toBeVisible({ timeout: 60_000 });
}
