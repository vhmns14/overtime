import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { trackErrors, isMobile } from "./helpers";

// The office reacts to activity (lights, sleep, wake, scoreboard), Hermes' skills and memory
// (bookshelf, filing cabinet, Library panel) and many Hermes in one building. Events go in the way
// the hermes-overtime plugin sends them; thresholds are shortened with ?sleep=&dim=.

const SHOTS = process.env.OVERTIME_SHOTS === "1";
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `docs/${name}-${isMobile(page) ? "mobile" : "desktop"}.png` }); };
interface Office { runId: string; ingestToken: string; viewToken: string; webhookSecret: string; privacy: string }
const now = () => new Date().toISOString();

async function newOffice(request: APIRequestContext, name = "My Hermes"): Promise<Office> {
  const r = await request.post("/api/ext/runs", { data: { agent: "hermes", privacy: "metadata", name } });
  expect(r.status()).toBe(201);
  return r.json();
}

async function hermes(request: APIRequestContext, o: Office, session: string, batch: Record<string, unknown>[]) {
  const r = await request.post(`/api/ext/runs/${o.runId}/hermes`, { headers: { authorization: `Bearer ${o.ingestToken}` }, data: { batch: batch.map((b) => ({ profile: "default", tool_name: null, tool_input: null, session_id: session, timestamp: now(), ...b })) } });
  expect(r.status()).toBe(200);
}

const tool = (name: string, input: Record<string, unknown>) => ({ hook_event_name: "post_tool_call", tool_name: name, tool_input: input, extra: { status: "ok", duration_ms: 30, tool_call_id: `c${Math.random()}` } });

async function seedSkills(request: APIRequestContext, o: Office) {
  await hermes(request, o, "s-skills", [
    { hook_event_name: "on_session_start", extra: { model: "openai/gpt-4o-mini", platform: "cli" } },
    tool("skill_manage", { action: "create", name: "deploy-checklist" }),
    tool("skill_manage", { action: "patch", name: "deploy-checklist" }),
    tool("skill_manage", { action: "patch", name: "deploy-checklist" }),
    tool("skill_manage", { action: "create", name: "pytest-fixer" }),
    tool("skill_manage", { action: "create", name: "release-notes" }),
    tool("memory", { action: "add", target: "memory" }),
    tool("session_search", { query: "x" }),
    { hook_event_name: "on_session_end", extra: { completed: true } },
  ]);
}

test("idle → lights dim → everyone falls asleep → a new session wakes them with a stretch", async ({ page, request }) => {
  const errors = trackErrors(page);
  const o = await newOffice(request);
  await seedSkills(request, o);
  await page.goto(`/watch/${o.runId}?sleep=14s&dim=5s&clock=22:40#v=${o.viewToken}`);
  const html = page.locator("html");
  await expect(page.locator(".office-canvas")).toBeVisible();
  await expect(html).toHaveAttribute("data-office-mode", "active");
  // the scoreboard counts today's session
  await expect(page.locator('[data-prop="scoreboard"]')).toHaveAttribute("aria-label", "Today: 1 succeeded, 0 failed");
  await expect(html).toHaveAttribute("data-office-mode", "idle", { timeout: 12_000 });
  await expect(html).toHaveAttribute("data-office-mode", "asleep", { timeout: 20_000 });
  await expect(page.locator(".actor.is-asleep")).toHaveCount(5, { timeout: 15_000 }); // four at their desks, one on the bench
  await page.waitForTimeout(1500);
  await shot(page, "office-asleep");

  await hermes(request, o, "s-wake", [{ hook_event_name: "on_session_start", extra: { model: "m", platform: "cli" } }, tool("read_file", { path: "README.md" })]);
  await expect(html).toHaveAttribute("data-office-mode", "waking", { timeout: 10_000 });
  await expect(page.locator(".actor.is-asleep")).toHaveCount(0, { timeout: 10_000 });
  await expect(html).toHaveAttribute("data-office-mode", "active", { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("library: a book per skill on the shelf (hover for versions), the cabinet, the Library panel", async ({ page, request }) => {
  const errors = trackErrors(page);
  const o = await newOffice(request);
  await seedSkills(request, o);
  await page.goto(`/watch/${o.runId}?clock=14:30#v=${o.viewToken}`);
  await expect(page.locator(".prop-book")).toHaveCount(3);
  await expect(page.locator(`.prop-book[data-skill="deploy-checklist"]`)).toHaveAttribute("data-tip", "deploy-checklist · 3 versions");
  await expect(page.locator('[data-prop="cabinet"]')).toHaveAttribute("data-tip", "Memory · 1 write · 1 recall");
  if (!isMobile(page)) {
    await page.locator(`.prop-book[data-skill="deploy-checklist"]`).hover();
    await expect(page.locator(".prop-tip")).toBeVisible();
    await expect(page.locator(".prop-tip")).toHaveText("deploy-checklist · 3 versions");
    await shot(page, "office-library-hover");
    await page.locator(`.prop-book[data-skill="pytest-fixer"]`).click();
  } else {
    // on a phone the office is zoomed into the desks: the Library lives in the bottom sheet
    await page.locator("#library summary").click();
  }
  const lib = page.locator("#library");
  await expect(lib).toHaveAttribute("open", "");
  await expect(lib.locator(".lib-row")).toHaveCount(3);
  await expect(lib.locator('.lib-row[data-skill="deploy-checklist"] .lib-meta')).toContainText("v3");
  await expect(lib.locator(".lib-mem")).toContainText("1 write");
  await expect(lib.locator(".lib-mem")).toContainText("1 recall");
  if (isMobile(page)) await lib.scrollIntoViewIfNeeded();
  await shot(page, "office-library");

  // a new skill arrives live: one more book, improvements bump the version
  await hermes(request, o, "s-skills", [tool("skill_manage", { action: "create", name: "csv-cleanup" }), tool("skill_manage", { action: "edit", name: "pytest-fixer" })]);
  await expect(page.locator(".prop-book")).toHaveCount(4);
  await expect(page.locator(`.prop-book[data-skill="pytest-fixer"]`)).toHaveAttribute("data-tip", "pytest-fixer · 2 versions");
  await expect(lib.locator(".lib-row")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("building: create from my office, add a second Hermes, ride the elevator between floors", async ({ page, request, browser }) => {
  const errors = trackErrors(page);
  const mine = await newOffice(request, "Laptop");
  await hermes(request, mine, "b-1", [{ hook_event_name: "on_session_start", extra: { model: "anthropic/claude-sonnet-4", platform: "cli" } }, { hook_event_name: "pre_api_request", extra: { model: "x" } }]);
  // this browser owns the office (as after "Connect Hermes")
  await page.addInitScript((c) => {
    if (!localStorage.getItem("overtime:hermes-office:v1")) localStorage.setItem("overtime:hermes-office:v1", JSON.stringify({ ...c, createdAt: Date.now(), origin: location.origin }));
  }, { runId: mine.runId, ingestToken: mine.ingestToken, viewToken: mine.viewToken, webhookSecret: mine.webhookSecret, privacy: "metadata" });
  await page.goto("/?target=hermes&clock=21:10");
  await expect(page.locator(".office-canvas")).toBeVisible();
  const go = isMobile(page) ? page.locator(".bar-actions [data-building]") : page.locator(".panel-nav [data-building]");
  await go.click();
  const building = page.locator(".building");
  await expect(building).toBeVisible();
  await expect(page.locator("#app")).toHaveClass(/is-building/);
  await expect(page.locator(".floor-hot")).toHaveCount(1);
  await expect(page.locator("#building-box .bx-floor")).toHaveCount(1);
  await expect(page.locator("#building-box")).toContainText("My Hermes");

  // add a second Hermes install: a new office with its own tokens and a one-line installer
  const box = page.locator("#building-box");
  await box.locator(".bx-add summary").click();
  await box.locator('[data-bx="name"]').fill("VPS · cron");
  await box.locator('[data-bx="add"]').click();
  await expect(box.locator('[data-bx="line"]')).toContainText("/hermes-overtime/install.sh | sh -s -- --url");
  await expect(box.locator('[data-bx="line"]')).toContainText("--token ot_ing_");
  await expect(page.locator(".floor-hot")).toHaveCount(2);
  await expect(page.locator(".floor-plate").filter({ hasText: "VPS · cron" })).toHaveCount(1);
  await shot(page, "building");

  // floor 1 is lit (Hermes is working there); walk in, then take the elevator to floor 2 and back
  await page.locator('.floor-hot[data-floor="1"]').click();
  await expect(building).toBeHidden({ timeout: 10_000 });
  const elevator = page.locator(".elevator");
  await expect(elevator).toBeVisible();
  await expect(elevator.locator('button[data-room="1"]')).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#hermes-box")).toBeVisible();
  await shot(page, "building-floor");
  await elevator.locator('button[data-room="2"]').click();
  await expect(elevator.locator('button[data-room="2"]')).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#mode-chip")).toContainText(/waiting for the first event|Hermes/i);
  await elevator.locator(".el-lobby").click();
  await expect(building).toBeVisible();

  // the read-only building link shows both floors to anyone
  const link = await page.evaluate(() => { const c = JSON.parse(localStorage.getItem("overtime:building:v1")!); return `/building/${c.id}#v=${c.viewToken}`; });
  // someone else's browser (no admin token in its storage)
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize()!, isMobile: isMobile(page), hasTouch: isMobile(page) });
  const viewer = await ctx.newPage();
  const verr = trackErrors(viewer);
  await viewer.goto(link);
  await expect(viewer.locator(".floor-hot")).toHaveCount(2);
  await expect(viewer.locator("#building-box")).toContainText("read-only");
  await expect(viewer.locator('[data-bx="add"]')).toHaveCount(0);
  await viewer.locator('.floor-hot[data-floor="2"]').click();
  await expect(viewer.locator(".elevator")).toBeVisible({ timeout: 10_000 });
  await expect(viewer.locator("#mode-chip")).toContainText("Read-only");
  expect(verr).toEqual([]);
  await ctx.close();
  expect(errors).toEqual([]);
});
