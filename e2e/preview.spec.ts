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
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/preview.html?speed=0.2&target=kopi-senja" style="width:1440px;height:900px;border:0"></iframe></body>` });
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

test("preview.html runs the PR demo offline (mocked GitHub in memory)", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 600, "desktop only");
  test.skip(!existsSync("preview.html"), "run npm run build:preview first");
  const html = readFileSync("preview.html", "utf8");
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
  await f.locator("#task-kind").selectOption("repo-fix");
  await f.locator("#run-btn").click();
  for (const title of [/PM wants to start with 5 tickets/, /1 check failing, fix before the PR/, /Ops wants to open a PR/]) {
    await expect(f.locator("#approval")).toContainText(title, { timeout: 90_000 });
    await f.locator('#approval [data-act="approve"]').click();
  }
  await expect(f.locator("#result")).toContainText("Pull request #8 is open", { timeout: 60_000 });
  await f.locator('#result [data-r="changes"]').click();
  await expect(f.locator("#files [data-diff-view] .ln.add")).toHaveText(["  return item.price * (item.qty ?? 1);"]);
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

test("preview.html opens on the recorded Hermes session and plays it offline", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 600, "desktop only");
  test.skip(!existsSync("preview.html"), "run npm run build:preview first");
  const html = readFileSync("preview.html", "utf8");
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const network: string[] = [];
  await page.route("http://preview.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/preview.html?speed=0.15" style="width:1440px;height:900px;border:0"></iframe></body>` });
    if (u.pathname === "/preview.html") return route.fulfill({ contentType: "text/html", body: html });
    network.push(u.pathname);
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://preview.test/");
  const f = page.frameLocator("#f");
  await expect(f.locator("#task-kind")).toHaveValue("demo-hermes");
  await f.locator('#hermes-box [data-hx="play"]').click();
  await expect(f.locator(".actor.is-borrowed .tag")).toHaveText("Check FastAPI docs", { timeout: 30_000 });
  await expect(f.locator("#approval")).toContainText("Hermes is waiting for approval", { timeout: 60_000 });
  await expect(f.locator("#approval [data-act]")).toHaveCount(0);
  await expect(f.locator("#log")).toContainText("Turn finished", { timeout: 60_000 });
  await expect(f.locator("#steps .step.done")).toHaveCount(5);
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

// The Hermes demo in the single file: the session plays, a skill lands on the shelf and in the Library
// panel, the offline sample building opens and its elevator rides back into the demo office, and
// the replay + timeline work. No network, no storage, no console errors.
test("preview.html: Hermes demo, library, sample building, replay and timeline offline", async ({ page }) => {
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
    if (u.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/preview.html?speed=0.05" style="width:1440px;height:900px;border:0"></iframe></body>` });
    if (u.pathname === "/preview.html") return route.fulfill({ contentType: "text/html", body: html });
    network.push(u.pathname);
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://preview.test/");
  const f = page.frameLocator("#f");
  await f.locator('#hermes-box [data-hx="play"]').click();
  // the session ends with a summary card; on the way Hermes saved a skill and a memory
  await expect(f.locator("#ins-card")).toBeVisible({ timeout: 60_000 });
  await expect(f.locator('.prop-book[data-skill="fastapi-health-endpoint"]')).toHaveCount(1);
  await expect(f.locator('[data-prop="cabinet"]')).toHaveAttribute("data-tip", /1 write/);
  await f.locator('.prop-book[data-skill="fastapi-health-endpoint"]').click();
  const lib = f.locator("#library");
  await expect(lib).toHaveAttribute("open", "");
  await expect(lib.locator('.lib-row[data-skill="fastapi-health-endpoint"]')).toBeVisible();
  // replay + timeline
  await f.locator('#ins-card [data-ins="timeline"]').click();
  expect(await f.locator("#insights .tl-item").count()).toBeGreaterThan(20);
  await f.locator("#insights .tl-row").nth(5).click();
  await expect(f.locator("#replay-bar")).toBeVisible();
  await f.locator("#insights [data-close]").click();
  await f.locator('#replay-bar [data-rp="close"]').click();
  // the offline sample building: three floors, floor 1 is the demo
  await f.locator('.panel-nav [data-building]').click();
  const box = f.locator("#building-box");
  await expect(box).toBeVisible();
  await expect(box).toContainText("Sample building");
  await expect(box.locator(".bx-floor")).toHaveCount(3);
  await box.locator('.bx-floor[data-room="2"]').click();
  await expect(f.locator(".toast")).toContainText("sample floor");
  await box.locator('.bx-floor[data-room="1"]').click();
  await expect(f.locator(".elevator")).toBeVisible({ timeout: 15_000 });
  await expect(f.locator(".elevator .el-ind")).toHaveText("1");
  await expect(box).toBeHidden();
  await f.locator(".elevator .el-lobby").click();
  await expect(box).toBeVisible();
  await box.locator('[data-bx="leave"]').click();
  await expect(box).toBeHidden();
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});
