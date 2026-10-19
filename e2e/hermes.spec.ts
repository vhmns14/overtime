import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { trackErrors, isMobile } from "./helpers";

// "Watch my Hermes": the default first screen. Events posted the way the hermes-overtime plugin
// (bearer token, batches) and Hermes outbound webhooks (HMAC) send them arrive live in the office,
// in the owner's tab and in the read-only /watch view.

const SHOTS = process.env.OVERTIME_SHOTS === "1";
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `docs/${name}-${isMobile(page) ? "mobile" : "desktop"}.png` }); };

interface Creds { runId: string; ingestToken: string; viewToken: string; webhookSecret: string }
const now = () => new Date().toISOString();
const SID = `20261019_${Math.random().toString(16).slice(2, 8)}`;

async function plugin(request: APIRequestContext, c: Creds, batch: Record<string, unknown>[]) {
  const r = await request.post(`/api/ext/runs/${c.runId}/hermes`, { headers: { authorization: `Bearer ${c.ingestToken}` }, data: { batch: batch.map((b) => ({ profile: "default", tool_name: null, tool_input: null, session_id: SID, timestamp: now(), ...b })) } });
  expect(r.status()).toBe(200);
  return r.json();
}

async function credsFrom(page: Page): Promise<Creds> {
  const raw = await page.evaluate(() => localStorage.getItem("overtime:hermes-office:v1"));
  expect(raw).toBeTruthy();
  return JSON.parse(raw!);
}

test("connect Hermes: setup snippet, waiting state, then live events in the office", async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto("/?speed=0.3");
  await expect(page.locator("#task-kind")).toHaveValue("hermes");
  const box = page.locator("#hermes-box");
  await expect(box).toContainText("See your own Hermes Agent work in this office");
  await expect(page.locator("#run-btn")).toBeHidden();
  await shot(page, "hermes-connect");
  await box.locator('[data-hx="create"]').click();

  const setup = page.locator("#hermes");
  await expect(setup).toBeVisible();
  const c = await credsFrom(page);
  const snippet = setup.locator("[data-snippet]");
  await expect(snippet).toContainText(`OVERTIME_URL=http://127.0.0.1:8787/api/ext/runs/${c.runId}/hermes`);
  await expect(snippet).toContainText(`OVERTIME_TOKEN=${c.ingestToken}`);
  await expect(snippet).toContainText("hermes plugins enable hermes-overtime");
  await expect(setup).toContainText("Waiting for the first event");
  // the curl lines in the snippet really serve the plugin
  const py = await request.get("/hermes-overtime/__init__.py");
  expect(py.status()).toBe(200);
  expect(await py.text()).toContain("def register(ctx");
  await setup.locator('[data-tab="webhook"]').click();
  await expect(snippet).toContainText(`url: http://127.0.0.1:8787/api/ext/hermes/webhook/${c.runId}`);
  await expect(snippet).toContainText(`OVERTIME_WEBHOOK_SECRET=${c.webhookSecret}`);
  await expect(snippet).toContainText("secret_env: OVERTIME_WEBHOOK_SECRET");
  await shot(page, "hermes-setup");

  // Hermes starts working
  await plugin(request, c, [
    { hook_event_name: "on_session_start", extra: { model: "openai/gpt-4o-mini", platform: "cli" } },
    { hook_event_name: "post_api_request", extra: { model: "openai/gpt-4o-mini", provider: "openrouter", api_duration: 1.4, usage: { input_tokens: 4539, output_tokens: 72 }, cost_usd: 0.0007, tool_calls: [{ id: "c1", function: { name: "todo", arguments: { todos: [{ id: "1", content: "Read the code", status: "in_progress" }, { id: "2", content: "Write the fix", status: "pending" }, { id: "3", content: "Run the tests", status: "pending" }] } } }] } },
    { hook_event_name: "post_tool_call", tool_name: "todo", tool_input: { todos: [{ id: "1", content: "Read the code", status: "in_progress" }, { id: "2", content: "Write the fix", status: "pending" }, { id: "3", content: "Run the tests", status: "pending" }] }, extra: { tool_call_id: "c1", status: "ok", duration_ms: 3 } },
    { hook_event_name: "post_api_request", extra: { model: "openai/gpt-4o-mini", usage: { input_tokens: 300, output_tokens: 90, cache_read_tokens: 4400 }, cost_usd: 0.0002, tool_calls: [{ id: "c2", function: { name: "write_file", arguments: { path: "app/health.py" } } }] } },
  ]);
  await expect(setup).toBeHidden(); // the first event closes the setup sheet
  const log = page.locator("#log");
  await expect(log).toContainText("plan: 3 items on the whiteboard");
  await expect(log).toContainText("→ write_file app/health.py");
  await expect(page.locator('.actor[data-role="coder"]')).toHaveClass(/is-working/);
  await expect(page.locator("#cost-usd")).toHaveText("$0.0009");
  await expect(page.locator("#mode-chip")).toContainText("openai/gpt-4o-mini");

  await plugin(request, c, [
    { hook_event_name: "post_tool_call", tool_name: "write_file", tool_input: { path: "app/health.py" }, extra: { tool_call_id: "c2", status: "ok", duration_ms: 108 } },
    { hook_event_name: "subagent_start", extra: { parent_session_id: SID, child_session_id: `${SID}_child`, child_role: "leaf", child_goal: "Check the docs" } },
    { hook_event_name: "post_tool_call", tool_name: "web_search", tool_input: { query: "x" }, session_id: `${SID}_child`, extra: { status: "ok", duration_ms: 900 } },
    { hook_event_name: "pre_approval_request", extra: { command: "sudo systemctl restart api", description: "Run a command with sudo", pattern_key: "sudo", surface: "cli" } },
  ]);
  await expect(log).toContainText("wrote app/health.py");
  await expect(page.locator('.actor[data-role="research"] .tag')).toHaveText("Subagent"); // metadata privacy: no goal text
  await expect(log).toContainText("web_search");
  const card = page.locator("#approval");
  await expect(card).toContainText("Hermes is waiting for approval");
  await expect(card).toContainText("Run a command with sudo");
  await expect(card).toContainText("Overtime only watches, it never approves");
  await expect(card.locator("button")).toHaveCount(0);
  await expect(page.locator(".actor.is-waiting")).toHaveCount(1);
  await shot(page, "hermes-live");

  await plugin(request, c, [{ hook_event_name: "post_approval_response", extra: { choice: "once" } }, { hook_event_name: "on_session_end", extra: { completed: true } }]);
  await expect(card).toBeHidden();
  await expect(log).toContainText("approval: once");
  await expect(log).toContainText("Turn finished");

  // persistent office: a brand-new Hermes session is picked up and followed automatically
  const SID2 = `${SID}_next`;
  await request.post(`/api/ext/runs/${c.runId}/hermes`, { headers: { authorization: `Bearer ${c.ingestToken}` }, data: { batch: [{ hook_event_name: "on_session_start", session_id: SID2, extra: { model: "openai/gpt-4o-mini", platform: "telegram" }, timestamp: now() }] } });
  await expect(page.locator('#hermes-box [data-hx="session"] option')).toHaveCount(2);
  await expect(page.locator('#hermes-box [data-hx="session"]')).toHaveValue(SID2);
  await expect(page.locator("#run-title")).toHaveText("Hermes · telegram");

  // a reload reconnects to the same office and replays it
  await page.reload();
  await expect(page.locator('#hermes-box [data-hx="session"] option')).toHaveCount(2);
  await page.locator('#hermes-box [data-hx="session"]').selectOption(SID);
  await expect(page.locator("#log")).toContainText("wrote app/health.py");
  await expect(page.locator('#hermes-box [data-hx="follow"]')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("watch view: read-only, needs the view token, gets events live (including signed webhooks)", async ({ page, request }) => {
  const errors = trackErrors(page);
  const res = await request.post("/api/ext/runs", { data: { agent: "hermes", privacy: "args" } });
  expect(res.status()).toBe(201);
  const c = (await res.json()) as Creds & { urls: { watch: string } };
  await plugin(request, c, [
    { hook_event_name: "on_session_start", extra: { model: "anthropic/claude-sonnet-4", platform: "discord" } },
    { hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "python -m pytest -q" }, extra: { tool_call_id: "t1" } },
  ]);
  const watchUrl = c.urls.watch.replace(/^https?:\/\/[^/]+/, "");
  await page.goto(watchUrl);
  await expect(page.locator("#mode-chip")).toContainText("Read-only");
  await expect(page.locator("#task-target")).toBeHidden();
  await expect(page.locator('#hermes-box [data-hx="setup"]')).toHaveCount(0);
  await expect(page.locator("#log")).toContainText("→ terminal python -m pytest");
  await expect(page.locator('.actor[data-role="reviewer"]')).toHaveClass(/is-working/);

  // a signed Hermes outbound webhook, exactly as agent/outbound_webhooks.py builds it
  const body = JSON.stringify({ hook_event_name: "post_tool_call", profile: "default", tool_name: "terminal", tool_input: { command: "python -m pytest -q" }, session_id: SID, cwd: "/srv", extra: { tool_call_id: "t1", status: "ok", duration_ms: 2100 }, delivery_id: "e2e-1", timestamp: now() });
  const sig = "sha256=" + createHmac("sha256", c.webhookSecret).update(body).digest("hex");
  const wh = await request.post(`/api/ext/hermes/webhook/${c.runId}`, { headers: { "content-type": "application/json", "x-hermes-signature-256": sig }, data: body });
  expect(wh.status()).toBe(200);
  await expect(page.locator("#log")).toContainText("✓ terminal python -m pytest · 2.1 s");
  const bad = await request.post(`/api/ext/hermes/webhook/${c.runId}`, { headers: { "content-type": "application/json", "x-hermes-signature-256": "sha256=" + "0".repeat(64) }, data: body });
  expect(bad.status()).toBe(401);
  await shot(page, "hermes-watch");

  // a wrong view token gets a clear message, not an office
  const other = await page.context().newPage();
  const otherErrors = trackErrors(other);
  await other.goto(`/watch/${c.runId}#v=ot_view_wrongwrongwrongwrongwrong`);
  await expect(other.locator("#hermes-box")).toContainText("This viewer link is not valid");
  expect(otherErrors.filter((e) => !/401/.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});

test("recorded Hermes demo plays through plan, subagent, approval and finish", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?speed=0.15&target=demo-hermes");
  await page.locator('#hermes-box [data-hx="play"]').click();
  await expect(page.locator(".actor.is-borrowed .tag")).toHaveText("Check FastAPI docs", { timeout: 30_000 });
  await expect(page.locator("#approval")).toContainText("Hermes is waiting for approval", { timeout: 60_000 });
  await expect(page.locator("#approval pre")).toContainText("sudo systemctl restart kedai-api");
  await expect(page.locator("#log")).toContainText("Turn finished", { timeout: 60_000 });
  await expect(page.locator("#steps-h li.done")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("the real Hermes run fixture renders: 0 console errors with plugin-shaped history", async ({ page, request }) => {
  test.skip(isMobile(page), "desktop only");
  const errors = trackErrors(page);
  const res = await request.post("/api/ext/runs", { data: { agent: "hermes" } });
  const c = (await res.json()) as Creds;
  const events = JSON.parse(readFileSync("tests/fixtures/hermes-0.19-real-run.json", "utf8")).map(({ seq, ...e }: { seq: number }) => (void seq, e));
  const r = await request.post(`/api/ext/runs/${c.runId}/events`, { headers: { authorization: `Bearer ${c.ingestToken}` }, data: { events } });
  expect((await r.json()).accepted).toBe(events.length);
  await page.addInitScript((creds) => localStorage.setItem("overtime:hermes-office:v1", JSON.stringify({ ...creds, privacy: "metadata", createdAt: Date.now(), origin: location.origin })), c);
  await page.goto("/?target=hermes");
  await expect(page.locator("#log")).toContainText("wrote …/demo/hello.py");
  await expect(page.locator("#cost-usd")).toHaveText("$0.0013");
  expect(errors).toEqual([]);
});
