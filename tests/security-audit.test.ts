// Regression tests for docs/SECURITY_AUDIT.md: exploit attempts against the Worker routes (tokens in
// URLs, IDOR across offices and buildings, webhook replay, storage growth), redaction coverage and
// notification escaping. Each test names the finding it pins down.
import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { handleExt, ExtOffice } from "../worker/src/ext";
import { handleBuilding, ExtBuilding, type BuildingEnv } from "../worker/src/building";
import { fakeNamespace } from "./helpers/fake-do";
import { redactString, redactDeep } from "../src/ext/redact";
import { mapHermes } from "../src/ext/hermes";
import { validateEvent } from "../src/ext/schema";
import { telegramBody, pushEndpointAllowed } from "../src/ext/notify";
import { safeEqual, randomToken } from "../src/ext/auth";

let env: BuildingEnv;
let offices: ReturnType<typeof fakeNamespace<ExtOffice>>;
const ORIGIN = "https://overtime.test";
let ip = 0;

beforeEach(() => {
  offices = fakeNamespace((ctx) => new ExtOffice(ctx as never, env));
  const buildings = fakeNamespace((ctx) => new ExtBuilding(ctx as never, env));
  env = { EXT_OFFICES: offices as never, EXT_BUILDINGS: buildings as never, EXT_TTL_DAYS: "30" };
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", "cf-connecting-ip": `10.7.${Math.floor(++ip / 200)}.${ip % 200}`, ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const url = new URL(ORIGIN + path);
  const res = path.startsWith("/api/ext/buildings") ? (await handleBuilding(new Request(url, init), env, url))! : (await handleExt(new Request(url, init), env, url))!;
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function office() {
  const r = await call("POST", "/api/ext/runs", { agent: "hermes" });
  expect(r.status).toBe(201);
  return r.json as { runId: string; ingestToken: string; viewToken: string; webhookSecret: string };
}

describe("AuthN/AuthZ across office routes", () => {
  it("the view token can read but never write events or fetch the share link", async () => {
    const o = await office();
    const ev = { type: "tool.start", session: "s", data: { name: "x" } };
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, ev, auth(o.viewToken))).status).toBe(401);
    expect((await call("POST", `/api/ext/runs/${o.runId}/hermes`, { hook_event_name: "on_session_start" }, auth(o.viewToken))).status).toBe(401);
    expect((await call("GET", `/api/ext/runs/${o.runId}/share`, undefined, auth(o.viewToken))).status).toBe(401);
    expect((await call("GET", `/api/ext/runs/${o.runId}/events`, undefined, auth(o.viewToken))).status).toBe(200);
  });

  it("IDOR: one office's tokens never open another office", async () => {
    const a = await office();
    const b = await office();
    for (const t of [a.ingestToken, a.viewToken]) {
      expect((await call("GET", `/api/ext/runs/${b.runId}/events`, undefined, auth(t))).status).toBe(401);
      expect((await call("POST", `/api/ext/runs/${b.runId}/events`, { type: "error", data: { message: "x" } }, auth(t))).status).toBe(401);
      expect((await call("GET", `/api/ext/runs/${b.runId}/share`, undefined, auth(t))).status).toBe(401);
    }
  });

  it("write-capable tokens are refused in the query string (logs, proxies, Referer)", async () => {
    const o = await office();
    const r = await call("GET", `/api/ext/runs/${o.runId}/share?v=${o.ingestToken}`);
    expect(r.status).toBe(400);
    expect(r.json.viewToken).toBeUndefined();
    expect((await call("POST", `/api/ext/runs/${o.runId}/events?v=${o.ingestToken}`, { type: "error", data: { message: "x" } })).status).toBe(400);
    // the viewer link's token keeps working in the query
    expect((await call("GET", `/api/ext/runs/${o.runId}/events?v=${o.viewToken}`)).status).toBe(200);
  });

  it("the live stream never accepts the ingest token in its URL", async () => {
    const o = await office();
    const obj = offices.get(o.runId) as unknown as { fetch(r: Request): Promise<Response> };
    const res = await obj.fetch(new Request(`${ORIGIN}/api/ext/runs/${o.runId}/stream?v=${o.ingestToken}`, { headers: { upgrade: "websocket" } }));
    expect(res.status).toBe(401);
  });

  it("tokens have 192 bits of randomness and are stored hashed (the ingest token never at rest)", async () => {
    const o = await office();
    expect(o.ingestToken.replace(/^ot_ing_/, "")).toHaveLength(32); // 24 bytes base64url
    const obj = offices.get(o.runId) as unknown as { ctx: { storage: { sql: { exec(q: string): { toArray(): { v: string }[] } } } } };
    const stored = obj.ctx.storage.sql.exec("SELECT v FROM meta").toArray().map((r) => r.v).join("\n");
    expect(stored).not.toContain(o.ingestToken);
    expect(new Set(Array.from({ length: 200 }, () => randomToken("ot_ing"))).size).toBe(200);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("buildings: IDOR", () => {
  it("a building cannot adopt someone else's office with its view token, a wrong ingest token, or another building's admin token", async () => {
    const victim = await office();
    const attacker = (await call("POST", "/api/ext/buildings", { name: "Evil" })).json;
    for (const ingestToken of [victim.viewToken, "ot_ing_" + "x".repeat(32), victim.webhookSecret]) {
      const r = await call("POST", `/api/ext/buildings/${attacker.buildingId}/floors`, { office: victim.runId, ingestToken }, auth(attacker.adminToken));
      expect(r.status).toBe(403);
    }
    const mine = (await call("POST", "/api/ext/buildings", { name: "Mine" })).json;
    expect((await call("POST", `/api/ext/buildings/${mine.buildingId}/floors`, { create: true }, auth(attacker.adminToken))).status).toBe(401);
    expect((await call("POST", `/api/ext/buildings/${mine.buildingId}/floors`, { create: true }, auth(mine.viewToken))).status).toBe(401);
    expect((await call("POST", `/api/ext/buildings/${mine.buildingId}/floors/1/remove`, {}, auth(mine.viewToken))).status).toBe(401);
  });

  it("the building admin token is refused in the query string", async () => {
    const b = (await call("POST", "/api/ext/buildings", { name: "Q" })).json;
    expect((await call("GET", `/api/ext/buildings/${b.buildingId}?v=${b.adminToken}`)).status).toBe(400);
    expect((await call("GET", `/api/ext/buildings/${b.buildingId}?v=${b.viewToken}`)).status).toBe(200);
  });
});

describe("webhook ingest", () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("a captured delivery without delivery_id cannot be replayed inside the timestamp window", async () => {
    const o = await office();
    const body = JSON.stringify({ hook_event_name: "on_session_start", session_id: "s1", timestamp: new Date().toISOString(), extra: {} });
    const h = { "x-hermes-signature-256": sign(o.webhookSecret, body) };
    const first = await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, h);
    expect(first.json.accepted).toBe(1);
    const replay = await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, h);
    expect(replay.json).toMatchObject({ accepted: 0, duplicate: true });
    const evs = (await call("GET", `/api/ext/runs/${o.runId}/events`, undefined, auth(o.viewToken))).json.events;
    expect(evs).toHaveLength(1);
  });

  it("a signature for one office never verifies on another", async () => {
    const a = await office();
    const b = await office();
    const body = JSON.stringify({ hook_event_name: "on_session_start", session_id: "s1", timestamp: new Date().toISOString(), delivery_id: "d1" });
    expect((await call("POST", `/api/ext/hermes/webhook/${b.runId}`, body, { "x-hermes-signature-256": sign(a.webhookSecret, body) })).status).toBe(401);
  });

  it("pruning the event log also prunes the session index", async () => {
    const o = await office();
    const obj = offices.get(o.runId) as unknown as { ctx: { storage: { sql: { exec(q: string, ...p: unknown[]): { one(): any } } } } };
    const sql = obj.ctx.storage.sql;
    for (let i = 0; i < 3; i++) sql.exec("INSERT INTO sessions (id, first_ts, last_ts, n, status) VALUES (?, 1, 1, 1, 'idle')", `ghost${i}`);
    for (let i = 0; i < 50_001; i++) sql.exec("INSERT INTO events (ts, session, type, body) VALUES (1, 'old', 'error', '{}')");
    const r = await call("POST", `/api/ext/runs/${o.runId}/events`, { type: "error", session: "new", data: { message: "x" } }, auth(o.ingestToken));
    expect(r.json.accepted).toBe(1);
    expect(sql.exec("SELECT COUNT(*) AS n FROM events").one().n).toBeLessThanOrEqual(50_000);
    expect(sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'ghost%'").one().n).toBe(0);
  });
});

describe("redaction coverage", () => {
  const cases = [
    "API_SERVER_KEY=abcdef0123456789", "export HF_TOKEN=hf_abcdefghijklmnopqrstu", "TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
    "curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "sk_live_abcdefghijklmnop1234",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789", "mysql --password hunter2hunter2", "gh --token=abcdefghijkl",
    "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX", "postgres://app:s3cr3tpw@db/x", "ya29.abcdefghijklmnopqrstuvwxyz",
  ];
  it.each(cases)("redacts %s", (c) => {
    const out = redactString(`run ${c} now`);
    expect(out).toContain("[redacted]");
    for (const part of ["abcdef0123456789", "hf_abc", "AAHdq", "sk_live_", "npm_abc", "hunter2", "abcdefghijkl", "XXXXXXXX", "s3cr3tpw", "ya29.a"]) expect(out).not.toContain(part);
  });

  it("keeps ordinary text intact", () => {
    for (const s of ["max_tokens=4000", "npm run test", "git push origin main", "at 12:30 the build ran", "cd /srv/api && pytest -q"]) expect(redactString(s)).toBe(s);
  });

  it("full privacy: secrets in tool args and outputs never reach storage", () => {
    const env = { hook_event_name: "post_tool_call", tool_name: "terminal", session_id: "s", tool_input: { command: "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 python run.py", api_key: "plain-secret-value" }, extra: { status: "ok", result: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok" } };
    const stored = mapHermes(env, "full").map((e) => validateEvent(e)).filter((v) => v.ok).map((v) => JSON.stringify((v as { event: unknown }).event)).join("\n");
    expect(stored).not.toMatch(/sk-or-v1-abc|ghp_abc|plain-secret-value/);
    expect(JSON.stringify(redactDeep({ nested: { password: "x", list: ["Bearer abcdefghijklmnopqrstuv"] } }))).not.toMatch(/abcdefghijklmnop|"x"/);
  });

  it("metadata privacy: a URL keeps only its host", () => {
    const evs = mapHermes({ hook_event_name: "post_tool_call", tool_name: "web_extract", session_id: "s", tool_input: { url: "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getUpdates" }, extra: { status: "ok" } }, "metadata");
    expect(JSON.stringify(evs)).not.toContain("AAHdq");
    expect((evs[0].data as { target?: string }).target).toBe("api.telegram.org");
  });
});

describe("notifications", () => {
  it("Telegram HTML: every value is escaped, including quotes in the link", () => {
    const b = telegramBody("1", { title: "<b>x</b>", body: "<a href=\"https://evil\">tap</a> & more", url: "https://o.test/watch/of-x#v=a\"><script>", tag: "t" });
    const text = String(b.text);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain('<a href="https://evil"');
    expect(text).toContain('href="https://o.test/watch/of-x#v=a&quot;&gt;&lt;script&gt;"');
  });

  it("Web Push only goes to browser push services (no SSRF to arbitrary hosts)", () => {
    for (const bad of ["https://169.254.169.254/latest", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/fcm.googleapis.com", "https://user@evil.test/", "https://localhost/"]) expect(pushEndpointAllowed(bad)).toBe(false);
    for (const good of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/abc"]) expect(pushEndpointAllowed(good)).toBe(true);
  });

  it("the service worker only opens this origin from a notification (no open redirect)", async () => {
    const listeners: Record<string, (e: any) => void> = {};
    const opened: string[] = [];
    const shown: any[] = [];
    const self = {
      location: { origin: "https://overtime.test" },
      registration: { scope: "https://overtime.test/", showNotification: (_t: string, o: any) => { shown.push(o); return Promise.resolve(); } },
      clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async (u: string) => { opened.push(u); } },
      skipWaiting: () => undefined,
      addEventListener: (n: string, f: (e: any) => void) => { listeners[n] = f; },
    };
    runInNewContext(readFileSync("public/sw.js", "utf8"), { self, URL });
    const push = (url: string) => listeners.push({ data: { json: () => ({ title: "t", url }) }, waitUntil: () => undefined });
    push("https://evil.test/phish");
    push("https://overtime.test/watch/of-abc#v=x");
    expect(shown.map((s) => s.data.url)).toEqual(["https://overtime.test/", "https://overtime.test/watch/of-abc#v=x"]);
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({ notification: { close: () => undefined, data: { url: "javascript:alert(1)" } }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(opened).toEqual(["https://overtime.test/"]);
  });
});

describe("security headers", () => {
  it("the app ships a CSP without inline scripts, no framing, no referrer", () => {
    const h = readFileSync("public/_headers", "utf8");
    const csp = h.match(/Content-Security-Policy: (.*)/)![1];
    expect(csp).toMatch(/script-src 'self'( 'unsafe-eval')?;/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    for (const x of ["X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "Cross-Origin-Opener-Policy: same-origin", "X-Frame-Options: DENY"]) expect(h).toContain(x);
  });
});
