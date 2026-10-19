// The /api/ext routes and the office Durable Object, run against real SQLite (node:sqlite) through
// a minimal ctx.storage.sql harness. Covers token auth, HMAC webhooks, size + rate limits, dedupe,
// redaction at rest, replay and the share endpoint.
import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { handleExt, ExtOffice, type ExtEnv } from "../worker/src/ext";
import { fakeNamespace } from "./helpers/fake-do";

let env: ExtEnv;
const ORIGIN = "https://overtime.test";

beforeEach(() => {
  const ns = fakeNamespace((ctx) => new ExtOffice(ctx as never, env));
  env = { EXT_OFFICES: ns as never, EXT_TTL_DAYS: "30" };
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = (await handleExt(new Request(ORIGIN + path, init), env, new URL(ORIGIN + path)))!;
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as Record<string, any> };
}

let ipSeq = 0;
async function createOffice(privacy = "metadata") {
  const r = await call("POST", "/api/ext/runs", { agent: "hermes", privacy }, { "cf-connecting-ip": `10.0.0.${++ipSeq}` });
  expect(r.status).toBe(201);
  return r.json as { runId: string; ingestToken: string; viewToken: string; webhookSecret: string; urls: Record<string, string> };
}

const sign = (secret: string, body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const hermesBody = (extra: Record<string, unknown> = {}, ts = new Date().toISOString()) => JSON.stringify({ hook_event_name: "post_tool_call", profile: "default", tool_name: "terminal", tool_input: { command: "npm run test" }, session_id: "s1", cwd: "/x", extra: { status: "ok", duration_ms: 5, ...extra }, delivery_id: `d-${Math.random()}`, timestamp: ts });

describe("office creation", () => {
  it("returns an office id, three distinct secrets and every URL the setup screen needs", async () => {
    const o = await createOffice("args");
    expect(o.runId).toMatch(/^of-[a-z0-9]+$/);
    expect(new Set([o.ingestToken, o.viewToken, o.webhookSecret]).size).toBe(3);
    expect(o.urls).toMatchObject({
      hermes: `${ORIGIN}/api/ext/runs/${o.runId}/hermes`, webhook: `${ORIGIN}/api/ext/hermes/webhook/${o.runId}`,
      events: `${ORIGIN}/api/ext/runs/${o.runId}/events`, stream: `wss://overtime.test/api/ext/runs/${o.runId}/stream`,
      watch: `${ORIGIN}/watch/${o.runId}#v=${o.viewToken}`,
    });
  });

  it("limits office creation per client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call("POST", "/api/ext/runs", {}, { "cf-connecting-ip": "9.9.9.9" })).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("token auth", () => {
  it("ingest needs the ingest token; the view token can only read", async () => {
    const o = await createOffice();
    const ev = { type: "session.start", session: "s1", data: {} };
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, ev)).status).toBe(401);
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, ev, { authorization: `Bearer ${o.viewToken}` })).status).toBe(401);
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, ev, { authorization: "Bearer ot_ing_wrong" })).status).toBe(401);
    const ok = await call("POST", `/api/ext/runs/${o.runId}/events`, ev, { authorization: `Bearer ${o.ingestToken}` });
    expect(ok).toMatchObject({ status: 200, json: { accepted: 1 } });
    expect((await call("GET", `/api/ext/runs/${o.runId}/events?after=0`)).status).toBe(401);
    expect((await call("GET", `/api/ext/runs/${o.runId}/events?after=0&v=${o.viewToken}`)).json.events).toHaveLength(1);
    expect((await call("GET", `/api/ext/runs/${o.runId}`, undefined, { authorization: `Bearer ${o.viewToken}` })).json).toMatchObject({ role: "view", events: 1, sessions: [{ id: "s1" }] });
  });

  it("tokens of one office do not open another", async () => {
    const a = await createOffice(), b = await createOffice();
    expect((await call("POST", `/api/ext/runs/${b.runId}/events`, { type: "session.start", data: {} }, { authorization: `Bearer ${a.ingestToken}` })).status).toBe(401);
  });

  it("share returns the viewer link for the ingest token only", async () => {
    const o = await createOffice();
    expect((await call("GET", `/api/ext/runs/${o.runId}/share`, undefined, { authorization: `Bearer ${o.viewToken}` })).status).toBe(401);
    expect((await call("GET", `/api/ext/runs/${o.runId}/share`, undefined, { authorization: `Bearer ${o.ingestToken}` })).json.watch).toBe(`${ORIGIN}/watch/${o.runId}#v=${o.viewToken}`);
  });

  it("unknown or malformed office ids are 404", async () => {
    expect((await call("GET", "/api/ext/runs/BAD_id")).status).toBe(404);
    expect((await call("POST", "/api/ext/hermes/webhook/not-an-office", "{}")).status).toBe(404);
  });
});

describe("ingest", () => {
  it("validates per event, stores the good ones in order, reports the bad ones", async () => {
    const o = await createOffice();
    const r = await call("POST", `/api/ext/runs/${o.runId}/events`, { events: [{ type: "session.start", session: "s1", data: {} }, { type: "nope", data: {} }, { type: "tool.start", session: "s1", data: { name: "web_search" } }] }, { authorization: `Bearer ${o.ingestToken}` });
    expect(r.json).toMatchObject({ received: 3, accepted: 2, rejected: [{ i: 1 }], lastSeq: 2 });
  });

  it("drops duplicate idempotency keys", async () => {
    const o = await createOffice();
    const ev = { type: "session.start", session: "s1", id: "once", data: {} };
    await call("POST", `/api/ext/runs/${o.runId}/events`, ev, { authorization: `Bearer ${o.ingestToken}` });
    const again = await call("POST", `/api/ext/runs/${o.runId}/events`, ev, { authorization: `Bearer ${o.ingestToken}` });
    expect(again.json.accepted).toBe(0);
  });

  it("redacts secrets before they are stored", async () => {
    const o = await createOffice();
    await call("POST", `/api/ext/runs/${o.runId}/events`, { type: "tool.start", session: "s1", data: { name: "terminal", args_summary: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list" } }, { authorization: `Bearer ${o.ingestToken}` });
    const stored = await call("GET", `/api/ext/runs/${o.runId}/events?v=${o.viewToken}`);
    expect(JSON.stringify(stored.json)).not.toContain("ghp_abc");
    expect(stored.json.events[0].data.args_summary).toBe("GITHUB_TOKEN=[redacted] gh pr list");
  });

  it("refuses oversized bodies and batches", async () => {
    const o = await createOffice();
    const big = await call("POST", `/api/ext/runs/${o.runId}/events`, JSON.stringify({ type: "message", data: { role: "user", text: "x".repeat(300_000) } }), { authorization: `Bearer ${o.ingestToken}` });
    expect(big.status).toBe(413);
    const many = await call("POST", `/api/ext/runs/${o.runId}/events`, Array.from({ length: 201 }, () => ({ type: "session.start", data: {} })), { authorization: `Bearer ${o.ingestToken}` });
    expect(many.status).toBe(413);
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, "{not json", { authorization: `Bearer ${o.ingestToken}` })).status).toBe(400);
  });

  it("rate limits a flood and says when to retry", async () => {
    const o = await createOffice();
    let limited: { status: number; headers: Headers } | null = null;
    for (let i = 0; i < 20 && !limited; i++) {
      const r = await call("POST", `/api/ext/runs/${o.runId}/events`, Array.from({ length: 200 }, () => ({ type: "agent.thinking", session: "s1", data: {} })), { authorization: `Bearer ${o.ingestToken}` });
      if (r.status === 429) limited = r;
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("plugin batches go through the Hermes mapper at the office's privacy level", async () => {
    const o = await createOffice("metadata");
    const batch = [
      { hook_event_name: "on_session_start", session_id: "h1", extra: { model: "m", platform: "cli" }, timestamp: new Date().toISOString() },
      { hook_event_name: "pre_approval_request", session_id: "h1", extra: { command: "sudo rm -rf /x", description: "delete" }, timestamp: new Date().toISOString() },
    ];
    const r = await call("POST", `/api/ext/runs/${o.runId}/hermes`, { batch }, { authorization: `Bearer ${o.ingestToken}` });
    expect(r.json).toMatchObject({ received: 2, accepted: 2 });
    const ev = (await call("GET", `/api/ext/runs/${o.runId}/events?v=${o.viewToken}`)).json.events;
    expect(ev[1]).toMatchObject({ type: "approval.request", data: { description: "delete" } });
    expect(ev[1].data.command).toBeUndefined();
  });
});

describe("Hermes outbound webhooks (HMAC)", () => {
  it("accepts a correctly signed delivery and maps it", async () => {
    const o = await createOffice();
    const body = hermesBody();
    const r = await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, { "x-hermes-signature-256": sign(o.webhookSecret, body) });
    expect(r).toMatchObject({ status: 200, json: { accepted: 1 } });
    const ev = (await call("GET", `/api/ext/runs/${o.runId}/events?v=${o.viewToken}`)).json.events;
    expect(ev[0]).toMatchObject({ type: "tool.end", data: { name: "terminal", target: "npm run test", ok: true } });
  });

  it("rejects missing, wrong and tampered signatures", async () => {
    const o = await createOffice();
    const body = hermesBody();
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body)).status).toBe(401);
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, { "x-hermes-signature-256": sign("wrong", body) })).status).toBe(401);
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body.replace("npm", "rm "), { "x-hermes-signature-256": sign(o.webhookSecret, body) })).status).toBe(401);
    // a token is not a signature
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, { authorization: `Bearer ${o.ingestToken}` })).status).toBe(401);
  });

  it("dedupes Hermes' retry of the same delivery and refuses stale replays", async () => {
    const o = await createOffice();
    const body = hermesBody();
    const h = { "x-hermes-signature-256": sign(o.webhookSecret, body) };
    await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, h);
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, body, h)).json).toMatchObject({ duplicate: true });
    const old = hermesBody({}, new Date(Date.now() - 10 * 60_000).toISOString());
    expect((await call("POST", `/api/ext/hermes/webhook/${o.runId}`, old, { "x-hermes-signature-256": sign(o.webhookSecret, old) })).status).toBe(400);
  });
});

describe("replay for late viewers", () => {
  it("pages after a sequence number and filters by session (including its subagents' sessions)", async () => {
    const o = await createOffice();
    const auth = { authorization: `Bearer ${o.ingestToken}` };
    await call("POST", `/api/ext/runs/${o.runId}/events`, [
      { type: "session.start", session: "A", data: {} },
      { type: "subagent.start", session: "A", data: { id: "C", child_session: "C" } },
      { type: "tool.start", session: "C", data: { name: "web_search" } },
      { type: "session.start", session: "B", data: {} },
    ], auth);
    const all = (await call("GET", `/api/ext/runs/${o.runId}/events?after=1&v=${o.viewToken}`)).json;
    expect(all.events.map((e: { seq: number }) => e.seq)).toEqual([2, 3, 4]);
    const a = (await call("GET", `/api/ext/runs/${o.runId}/events?session=A&v=${o.viewToken}`)).json;
    expect(a.events.map((e: { session: string }) => e.session)).toEqual(["A", "A", "C"]);
    const meta = (await call("GET", `/api/ext/runs/${o.runId}?v=${o.viewToken}`)).json;
    expect(meta.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["A", "B"]); // the child session is not listed
  });
});
