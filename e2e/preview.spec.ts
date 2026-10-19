import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

// The single-file build (npm run build:preview) inside a sandboxed iframe: scripts only, no
// same-origin (so no localStorage), no network. The demo must run start → approve → preview.
test("preview.html runs the demo offline in a sandboxed iframe", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 600, "desktop only");
  test.skip(!existsSync("preview.html"), "run npm run build:preview first");
  const html = readFileSync("preview.html", "utf8");
  expect(html.match(/<script\b[^>]*>/g)).toEqual(["<script>"]);
  expect(/module/i.test(html)).toBe(false);
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const network: string[] = [];
  await page.route("http://preview.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/preview.html?speed=0.2" style="width:1440px;height:900px;border:0"></iframe></body>` });
    if (u.pathname === "/preview.html") return route.fulfill({ contentType: "text/html", body: html });
    network.push(u.pathname);
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://preview.test/");
  const f = page.frameLocator("#f");
  await expect(f.locator("#run-btn")).toBeVisible();
  await f.locator("#run-btn").click();
  for (const title of [/PM wants to start/, /2 tests failing/, /Ops wants to deploy/]) {
    await expect(f.locator("#approval")).toContainText(title, { timeout: 90_000 });
    await f.locator('#approval [data-act="approve"]').click();
  }
  await expect(f.locator("#result")).toContainText("Preview is live", { timeout: 60_000 });
  await expect(f.locator("#result")).toContainText("Rendered in-browser");
  await f.locator('#result [data-r="preview"]').click();
  await expect(f.frameLocator("#files iframe").locator("h1")).toHaveText("Coffee for the hour the sky turns orange.");
  await f.locator('#files [data-tab="files"]').click();
  await f.locator("#files [data-diff]").check();
  await expect(f.locator("#files .ln.add")).toHaveCount(2);
  await f.locator("#files [data-close]").click();
  await f.locator('.panel-nav [data-open="settings"]').click();
  await expect(f.locator("#settings")).toContainText("Storage is unavailable here");
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});
