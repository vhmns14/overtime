import { test, expect, type Page, type Download } from "@playwright/test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { trackErrors, isMobile } from "./helpers";

// Insights: replay timelapse (controls + export), the timeline (filter + jump), the session summary
// card, the cost dashboard with a budget, and stuck detection on a live office.

const SHOTS = process.env.OVERTIME_SHOTS === "1";
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `docs/${name}-${isMobile(page) ? "mobile" : "desktop"}.png` }); };
const insightsBtn = (page: Page) => page.locator('[data-open="insights"]:visible').first();

async function playDemoToEnd(page: Page) {
  await page.goto("/?speed=0.05&target=demo-hermes");
  await page.locator('#hermes-box [data-hx="play"]').click();
  const card = page.locator("#ins-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("Session summary");
  return card;
}

async function sizeOf(d: Download) {
  const p = await d.path();
  return p ? statSync(p).size : 0;
}

async function setRange(page: Page, sel: string, value: number) {
  await page.locator(sel).evaluate((el, v) => { const i = el as HTMLInputElement; i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); }, value);
}

test("replay controls, timeline filter + jump, summary card and the cost dashboard on the Hermes demo", async ({ page }) => {
  const errors = trackErrors(page);
  const card = await playDemoToEnd(page);
  await expect(card).toContainText(/completed|closed/);
  await shot(page, "insights-summary-card");

  // replay
  await card.locator('[data-ins="replay"]').click();
  const bar = page.locator("#replay-bar");
  await expect(bar).toBeVisible();
  await expect(page.locator("#mode-chip")).toContainText("Replay");
  await expect(page.locator(".rp-open")).toBeHidden();
  await bar.locator('[data-rp="speed"]').selectOption("16");
  await expect(page.locator("#mode-chip")).toContainText("16x");
  const time = bar.locator('[data-rp="time"]');
  await expect(time).not.toHaveText(/^0:00 \//, { timeout: 10_000 });
  await bar.locator('[data-rp="play"]').click(); // pause
  await expect(bar.locator('[data-rp="play"]')).toHaveAttribute("aria-label", "Play");
  const paused = await time.textContent();
  await page.waitForTimeout(400);
  expect(await time.textContent()).toBe(paused);
  // scrub back to the start: the log empties, the office resets
  await setRange(page, '[data-rp="scrub"]', 0);
  await expect(time).toHaveText(/^0:00 \//);
  await expect(page.locator("#log")).toContainText(/nothing has happened yet|Session started/);
  // jump event by event
  await bar.locator('[data-rp="next"]').click();
  await bar.locator('[data-rp="next"]').click();
  await bar.locator('[data-rp="next"]').click();
  await expect(page.locator("#log")).toContainText("Session started");
  await setRange(page, '[data-rp="scrub"]', 30_000);
  await expect(time).toHaveText(/^0:30 \//);
  await expect(page.locator("#log li").first()).not.toHaveText(/nothing has happened/);
  await shot(page, "insights-replay");

  // timeline: filter, search, jump
  await bar.locator('[data-rp="timeline"]').click();
  const ov = page.locator("#insights");
  await expect(ov).toBeVisible();
  await expect(ov.locator('[data-tab="timeline"]')).toHaveAttribute("aria-selected", "true");
  const items = ov.locator(".tl-item");
  const total = await items.count();
  expect(total).toBeGreaterThan(20);
  await ov.locator('[data-filter="errors"]').click();
  await expect(ov.locator('[data-filter="errors"]')).toHaveAttribute("aria-pressed", "true");
  const errCount = await items.count();
  expect(errCount).toBeGreaterThan(0);
  expect(errCount).toBeLessThan(total);
  await expect(items.first()).toContainText("pytest");
  await ov.locator('[data-filter="errors"]').click();
  await ov.locator('[data-tl="q"]').fill("test_health");
  await expect(items.first()).toContainText("test_health");
  const n = await items.count();
  expect(n).toBeLessThan(total);
  await ov.locator('[data-tl="q"]').fill("");
  await ov.locator('[data-filter="approvals"]').click();
  await ov.locator(".tl-row").first().click();
  const sel = ov.locator(".tl-item.is-sel");
  await expect(sel).toHaveCount(1);
  await expect(sel.locator(".tl-detail")).toContainText("command");
  await expect(sel).toContainText("Asked for approval");
  // the office is at that moment: paused, waiting for approval
  await expect(bar.locator('[data-rp="play"]')).toHaveAttribute("aria-label", "Play");
  await expect(page.locator(".actor.is-waiting")).toHaveCount(1);
  await expect(page.locator("#log")).toContainText("asked for approval");
  await shot(page, "insights-timeline");

  // summary tab: PNG + markdown downloads
  await ov.locator('[data-tab="summary"]').click();
  await expect(ov.locator(".sum-card")).toContainText("What was done");
  await expect(ov.locator(".sum-card")).toContainText("Planned 5 steps, finished 5");
  await expect(ov.locator(".sum-card")).toContainText("app/main.py");
  let dl = page.waitForEvent("download");
  await ov.locator('[data-sum="png"]').click();
  const png = await dl;
  expect(png.suggestedFilename()).toMatch(/^overtime-session-.+\.png$/);
  expect(await sizeOf(png)).toBeGreaterThan(20_000);
  dl = page.waitForEvent("download");
  await ov.locator('[data-sum="md"]').click();
  const md = await dl;
  const mdText = readFileSync((await md.path())!, "utf8");
  expect(mdText).toContain("### What was done");
  expect(mdText).toContain("_Made with Overtime_");
  await shot(page, "insights-summary");

  // costs
  await ov.locator('[data-tab="costs"]').click();
  await expect(ov.locator(".kpi")).toHaveCount(4);
  await expect(ov.locator(".ins-note")).toContainText("sample");
  expect(await ov.locator("svg.chart rect.ch-bar").count()).toBe(14);
  await expect(ov.locator(".hbars li").first()).toBeVisible();
  await ov.locator('[data-cost="tokens"]').click();
  await expect(ov.locator('[data-cost="tokens"]')).toHaveAttribute("aria-pressed", "true");
  await ov.locator('[data-days="30"]').click();
  expect(await ov.locator("svg.chart rect.ch-bar").count()).toBe(30);
  await shot(page, "insights-costs");

  // a budget: the banner and the budget.exceeded signal
  await page.evaluate(() => { (window as unknown as { __sig: string[] }).__sig = []; window.addEventListener("overtime:signal", (e) => (window as unknown as { __sig: string[] }).__sig.push((e as CustomEvent).detail.type)); });
  await ov.locator('[data-tab="alerts"]').click();
  await ov.locator('[data-al="dailyUsd"]').fill("0.01");
  await ov.locator('[data-al="save"]').click();
  await expect(ov.locator(".sig-list")).toContainText("budget.exceeded");
  expect(await page.evaluate(() => (window as unknown as { __sig: string[] }).__sig)).toEqual(["budget.exceeded"]);
  await ov.locator("[data-close]").click();
  const banner = page.locator('#ins-banners [data-banner="budget"]');
  await expect(banner).toContainText("Daily budget exceeded");
  await shot(page, "insights-budget");
  await banner.locator('[data-ins="dismiss-budget"]').click();
  await expect(banner).toBeHidden();

  // leave the replay: back to the live (finished) demo state
  await bar.locator('[data-rp="close"]').click();
  await expect(bar).toBeHidden();
  await expect(page.locator("#mode-chip")).toContainText("Demo");
  expect(errors).toEqual([]);
});

test("export the replay: GIF and WebM produce non-empty files", async ({ page }) => {
  const errors = trackErrors(page);
  const card = await playDemoToEnd(page);
  await card.locator('[data-ins="replay"]').click();
  const bar = page.locator("#replay-bar");
  await bar.locator('[data-rp="speed"]').selectOption("16");
  await bar.locator('[data-rp="export-toggle"]').click();
  await expect(bar.locator(".rp-export")).toBeVisible();
  await expect(bar.locator('[data-rp="export-status"]')).toContainText("16x");
  let dl = page.waitForEvent("download", { timeout: 90_000 });
  await bar.locator('[data-rp="export-start"]').click();
  await expect(bar.locator('[data-rp="export-status"]')).toContainText(/Recording|Encoding/);
  const gif = await dl;
  expect(gif.suggestedFilename()).toMatch(/^overtime-replay-.+\.gif$/);
  const gifSize = await sizeOf(gif);
  expect(gifSize).toBeGreaterThan(10_000);
  expect(gifSize).toBeLessThan(15_000_000);
  const head = readFileSync((await gif.path())!).subarray(0, 6).toString("latin1");
  expect(head).toBe("GIF89a");
  if (SHOTS) await gif.saveAs(`docs/insights-replay-${isMobile(page) ? "mobile" : "desktop"}.gif`);
  await expect(bar.locator('[data-rp="result"] img')).toBeVisible();
  await expect(bar.locator('[data-rp="export-status"]')).toContainText("Done");
  await shot(page, "insights-export");

  const webm = bar.locator('input[name="rp-kind"][value="webm"]');
  if (await webm.isEnabled()) {
    await webm.check();
    dl = page.waitForEvent("download", { timeout: 90_000 });
    await bar.locator('[data-rp="export-start"]').click();
    const vid = await dl;
    expect(vid.suggestedFilename()).toMatch(/\.(webm|mp4)$/);
    expect(await sizeOf(vid)).toBeGreaterThan(1000);
  }
  // the speed the user picked comes back after an export
  await expect(bar.locator('[data-rp="speed"]')).toHaveValue("16");
  expect(errors).toEqual([]);
});

test("stuck detection on a live office: banner, the office '?', a session.stuck signal, dismiss", async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto("/?speed=0.3");
  await page.locator('#hermes-box [data-hx="create"]').click();
  await expect(page.locator("#hermes")).toBeVisible();
  const c = JSON.parse((await page.evaluate(() => localStorage.getItem("overtime:hermes-office:v1")))!) as { runId: string; ingestToken: string };
  await page.evaluate(() => { (window as unknown as { __sig: unknown[] }).__sig = []; window.addEventListener("overtime:signal", (e) => (window as unknown as { __sig: unknown[] }).__sig.push((e as CustomEvent).detail)); });
  const post = async (events: Record<string, unknown>[]) => {
    const r = await request.post(`/api/ext/runs/${c.runId}/events`, { headers: { authorization: `Bearer ${c.ingestToken}` }, data: events.map((e) => ({ session: "loop-1", ...e })) });
    expect(r.status()).toBe(200);
  };
  await post([
    { type: "session.start", data: { model: "openai/gpt-4o-mini", platform: "cli", title: "Fix the flaky test" } },
    { type: "llm.call", data: { model: "openai/gpt-4o-mini", input_tokens: 3000, output_tokens: 60, cost_usd: 0.0005 } },
  ]);
  await expect(page.locator("#hermes")).toBeHidden();
  const calls = [1, 2, 3, 4].flatMap((i) => [
    { type: "tool.start", data: { name: "terminal", call_id: `t${i}`, target: "npm run test" } },
    { type: "tool.end", data: { name: "terminal", call_id: `t${i}`, ok: true, target: "npm run test", duration_ms: 900 } },
    { type: "llm.call", data: { model: "openai/gpt-4o-mini", input_tokens: 3200, output_tokens: 40, cost_usd: 0.0005 } },
  ]);
  await post(calls.slice(0, 6));
  await expect(page.locator("#log")).toContainText("terminal npm run test");
  await expect(page.locator('#ins-banners [data-banner="stuck"]')).toHaveCount(0);
  await post(calls.slice(6));
  const banner = page.locator('#ins-banners [data-banner="stuck"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Hermes looks stuck");
  await expect(banner).toContainText("terminal npm run test 4 times in a row");
  await expect(page.locator(".actor.is-stuck .qmark")).toHaveCount(1);
  const sig = await page.evaluate(() => (window as unknown as { __sig: { type: string; reasons: { kind: string }[]; title: string }[] }).__sig);
  expect(sig).toHaveLength(1);
  expect(sig[0]).toMatchObject({ type: "session.stuck", title: "Fix the flaky test" });
  expect(sig[0].reasons[0].kind).toBe("repeat-tool");
  await shot(page, "insights-stuck");

  // costs come from the Worker's insights endpoint for the whole office
  await insightsBtn(page).click();
  await page.locator('#insights [data-tab="costs"]').click();
  await expect(page.locator("#insights .kpi").nth(2)).toContainText("5 model calls");
  await page.locator("#insights [data-close]").click();

  await banner.locator('[data-ins="dismiss-stuck"]').click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".actor.is-stuck")).toHaveCount(0);
  // a fifth identical call keeps the same streak: still dismissed, no second signal
  await post([{ type: "tool.start", data: { name: "terminal", call_id: "t5", target: "npm run test" } }]);
  await expect(page.locator("#log")).toContainText("→ terminal npm run test");
  await page.waitForTimeout(400);
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sig: unknown[] }).__sig.length)).toBe(1);
  expect(errors).toEqual([]);
});

test("preview.html: insights run offline in the sandboxed single file (replay, timeline, summary, costs, GIF)", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 600, "desktop only");
  test.skip(!existsSync("preview.html"), "run npm run build:preview first");
  const html = readFileSync("preview.html", "utf8");
  expect(html.match(/<script\b[^>]*>/g)).toEqual(["<script>"]);
  expect(/module/i.test(html)).toBe(false);
  const errors = trackErrors(page);
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
  await expect(f.locator("#ins-card")).toBeVisible({ timeout: 60_000 });
  await f.locator('#ins-card [data-ins="timeline"]').click();
  expect(await f.locator("#insights .tl-item").count()).toBeGreaterThan(20);
  await f.locator("#insights .tl-row").nth(10).click();
  await expect(f.locator("#replay-bar")).toBeVisible();
  await expect(f.locator("#insights .tl-item.is-sel .tl-detail")).toBeVisible();
  await f.locator('#insights [data-tab="summary"]').click();
  await expect(f.locator("#insights .sum-card")).toContainText("What was done");
  await f.locator('#insights [data-tab="costs"]').click();
  expect(await f.locator("#insights svg.chart rect.ch-bar").count()).toBe(14);
  await f.locator("#insights [data-close]").click();
  const bar = f.locator("#replay-bar");
  await bar.locator('[data-rp="speed"]').selectOption("16");
  await bar.locator('[data-rp="export-toggle"]').click();
  await bar.locator('[data-rp="export-start"]').click();
  await expect(bar.locator('[data-rp="result"] img')).toBeVisible({ timeout: 90_000 });
  await expect(bar.locator('[data-rp="export-status"]')).toContainText("Done");
  await bar.locator('[data-rp="close"]').click();
  await expect(bar).toBeHidden();
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});
