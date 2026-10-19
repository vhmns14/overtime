// External agents (Hermes first): one long-lived "office" per agent install, stored in its own
// SQLite Durable Object. Agents post events (generic schema, Hermes plugin batches, or signed
// Hermes outbound webhooks); viewers get a replay plus a live WebSocket stream.

import { DurableObject } from "cloudflare:workers";
import { validateEvent, unpackBatch, LIMITS, type ExtEvent, type ExtEventIn } from "../../src/ext/schema";
import { mapHermes, type HermesEnvelope, type Privacy } from "../../src/ext/hermes";
import { randomToken, newOfficeId, OFFICE_ID, sha256Hex, safeEqual, bearer, verifyHermesSignature, freshTimestamp, TokenBucket } from "../../src/ext/auth";
import { json } from "./lib";

export interface ExtEnv {
  EXT_OFFICES: DurableObjectNamespace;
  EXT_TTL_DAYS?: string;
}

const MAX_EVENTS = 50_000;
const PRUNE = 5_000;
const MAX_WS = 50;
const PRIVACY = new Set(["metadata", "args", "full"]);

interface OfficeConfig {
  id: string;
  agent: "hermes" | "generic";
  name: string;
  privacy: Privacy;
  createdAt: number;
  ingestHash: string;
  viewHash: string;
  viewToken: string;
  webhookSecret: string;
}

type Who = "ingest" | "view" | null;

export const EXT_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-hermes-signature-256, x-hermes-event, x-hermes-delivery",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

const ok = (data: unknown, status = 200, extra: Record<string, string> = {}) => json(data, status, { ...EXT_CORS, ...extra });

// best-effort per-isolate limit on office creation (each office is cheap, but not free)
const createHits = new Map<string, number[]>();
function createAllowed(ip: string, now = Date.now()): boolean {
  const hits = (createHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 10) return false;
  hits.push(now);
  createHits.set(ip, hits);
  if (createHits.size > 5000) createHits.clear();
  return true;
}

async function readBody(req: Request): Promise<{ text: string } | { error: Response }> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > LIMITS.bodyBytes) return { error: ok({ error: `body larger than ${LIMITS.bodyBytes} bytes` }, 413) };
  const text = await req.text();
  if (text.length > LIMITS.bodyBytes) return { error: ok({ error: `body larger than ${LIMITS.bodyBytes} bytes` }, 413) };
  return { text };
}

interface OfficeRPC {
  init(cfg: OfficeConfig): Promise<boolean>;
  ingest(token: string, raw: unknown[], kind: "events" | "hermes"): Promise<{ status: number; body: unknown; retryAfter?: number }>;
  webhook(rawBody: string, sig: string | null): Promise<{ status: number; body: unknown; retryAfter?: number }>;
  events(token: string, after: number, session: string, limit: number): Promise<{ status: number; body: unknown }>;
  meta(token: string): Promise<{ status: number; body: unknown }>;
  share(token: string): Promise<{ status: number; body: unknown }>;
}

const stub = (env: ExtEnv, id: string) => env.EXT_OFFICES.get(env.EXT_OFFICES.idFromName(id)) as unknown as OfficeRPC & { fetch(r: Request): Promise<Response> };

/** Routes /api/ext/*. Returns null when the path is not ours. */
export async function handleExt(req: Request, env: ExtEnv, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/ext/")) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: EXT_CORS });
  const origin = url.origin;

  if (path === "/api/ext/runs" && req.method === "POST") {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    if (!createAllowed(ip)) return ok({ error: "too many offices created, try again in a minute" }, 429, { "retry-after": "60" });
    const b = await readBody(req);
    if ("error" in b) return b.error;
    let body: Record<string, unknown> = {};
    try { body = b.text ? JSON.parse(b.text) : {}; } catch { return ok({ error: "invalid JSON" }, 400); }
    const agent = body.agent === "generic" ? "generic" : "hermes";
    const privacy = (typeof body.privacy === "string" && PRIVACY.has(body.privacy) ? body.privacy : "metadata") as Privacy;
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : agent === "hermes" ? "My Hermes" : "My agent";
    const id = newOfficeId();
    const ingestToken = randomToken("ot_ing");
    const viewToken = randomToken("ot_view");
    const webhookSecret = randomToken("ot_whs");
    const cfg: OfficeConfig = { id, agent, name, privacy, createdAt: Date.now(), ingestHash: await sha256Hex(ingestToken), viewHash: await sha256Hex(viewToken), viewToken, webhookSecret };
    if (!(await stub(env, id).init(cfg))) return ok({ error: "id collision, try again" }, 409);
    return ok({
      runId: id, agent, name, privacy, ingestToken, viewToken, webhookSecret,
      urls: {
        events: `${origin}/api/ext/runs/${id}/events`,
        hermes: `${origin}/api/ext/runs/${id}/hermes`,
        webhook: `${origin}/api/ext/hermes/webhook/${id}`,
        stream: `${origin.replace(/^http/, "ws")}/api/ext/runs/${id}/stream`,
        watch: `${origin}/watch/${id}#v=${viewToken}`,
      },
    }, 201);
  }

  const wh = path.match(/^\/api\/ext\/hermes\/webhook\/([^/]+)$/);
  if (wh) {
    if (req.method !== "POST") return ok({ error: "method not allowed" }, 405);
    if (!OFFICE_ID.test(wh[1])) return ok({ error: "unknown office" }, 404);
    const b = await readBody(req);
    if ("error" in b) return b.error;
    const r = await stub(env, wh[1]).webhook(b.text, req.headers.get("x-hermes-signature-256"));
    return ok(r.body, r.status, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
  }

  const m = path.match(/^\/api\/ext\/runs\/([^/]+)(?:\/(events|hermes|stream|share))?$/);
  if (!m) return ok({ error: "not found" }, 404);
  const [, id, sub] = m;
  if (!OFFICE_ID.test(id)) return ok({ error: "unknown office" }, 404);
  const s = stub(env, id);
  if (sub === "stream") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return ok({ error: "expected a WebSocket upgrade" }, 426);
    return s.fetch(req);
  }
  const token = bearer(req) || url.searchParams.get("v") || "";
  if ((sub === "events" || sub === "hermes") && req.method === "POST") {
    const b = await readBody(req);
    if ("error" in b) return b.error;
    let body: unknown;
    try { body = JSON.parse(b.text); } catch { return ok({ error: "invalid JSON" }, 400); }
    let list: unknown[] | null;
    if (sub === "hermes") {
      const o = body as Record<string, unknown>;
      list = Array.isArray(body) ? body : Array.isArray(o?.batch) ? (o.batch as unknown[]) : o && typeof o.hook_event_name === "string" ? [o] : null;
    } else list = unpackBatch(body);
    if (!list) return ok({ error: sub === "hermes" ? "expected a Hermes hook envelope, an array of them, or {batch:[…]}" : "expected an event, an array of events, or {events:[…]}" }, 400);
    if (list.length > LIMITS.batch) return ok({ error: `at most ${LIMITS.batch} items per request` }, 413);
    const r = await s.ingest(token, list, sub === "hermes" ? "hermes" : "events");
    return ok(r.body, r.status, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
  }
  if (sub === "events" && req.method === "GET") {
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 2000) || 2000));
    const r = await s.events(token, after, url.searchParams.get("session") ?? "", limit);
    return ok(r.body, r.status);
  }
  if (sub === "share" && req.method === "GET") {
    const r = await s.share(token);
    if (r.status === 200) (r.body as Record<string, string>).watch = `${origin}/watch/${id}#v=${(r.body as Record<string, string>).viewToken}`;
    return ok(r.body, r.status);
  }
  if (!sub && req.method === "GET") {
    const r = await s.meta(token);
    return ok(r.body, r.status);
  }
  return ok({ error: "method not allowed" }, 405);
}

export class ExtOffice extends DurableObject<ExtEnv> {
  private cfg: OfficeConfig | null = null;
  private reqBucket = new TokenBucket(120, 20);
  private evBucket = new TokenBucket(2000, 200);
  private alarmAt = 0;

  constructor(ctx: DurableObjectState, env: ExtEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT NOT NULL, type TEXT NOT NULL, eid TEXT, body TEXT NOT NULL)");
      sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_eid ON events(eid) WHERE eid IS NOT NULL");
      sql.exec("CREATE INDEX IF NOT EXISTS events_session ON events(session, seq)");
      sql.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, first_ts INTEGER, last_ts INTEGER, n INTEGER, model TEXT, platform TEXT, status TEXT)");
      sql.exec("CREATE TABLE IF NOT EXISTS children (child TEXT PRIMARY KEY, parent TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'cfg'").toArray()[0];
      this.cfg = row ? JSON.parse(row.v) : null;
    });
  }

  async init(cfg: OfficeConfig): Promise<boolean> {
    if (this.cfg) return false;
    this.cfg = cfg;
    this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('cfg', ?)", JSON.stringify(cfg));
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('last', ?)", String(Date.now()));
    await this.touchAlarm(true);
    return true;
  }

  private async who(token: string): Promise<Who> {
    if (!this.cfg || !token) return null;
    const h = await sha256Hex(token);
    if (safeEqual(h, this.cfg.ingestHash)) return "ingest";
    if (safeEqual(h, this.cfg.viewHash)) return "view";
    return null;
  }

  private limit(n: number): { status: number; body: unknown; retryAfter?: number } | null {
    const r = this.reqBucket.take(1);
    if (!r.ok) return { status: 429, body: { error: "rate limited" }, retryAfter: r.retryAfterS };
    const e = this.evBucket.take(Math.max(1, n));
    if (!e.ok) return { status: 429, body: { error: "too many events" }, retryAfter: e.retryAfterS };
    return null;
  }

  async ingest(token: string, raw: unknown[], kind: "events" | "hermes") {
    if (!this.cfg) return { status: 404, body: { error: "unknown office" } };
    if ((await this.who(token)) !== "ingest") return { status: 401, body: { error: "a valid ingest token is required (Authorization: Bearer ot_ing_…)" } };
    const limited = this.limit(raw.length);
    if (limited) return limited;
    const events: unknown[] = kind === "hermes" ? raw.flatMap((x) => mapHermes(x as HermesEnvelope, this.cfg!.privacy)) : raw;
    return { status: 200, body: this.store(events, raw.length) };
  }

  async webhook(rawBody: string, sig: string | null) {
    if (!this.cfg) return { status: 404, body: { error: "unknown office" } };
    if (!(await verifyHermesSignature(this.cfg.webhookSecret, rawBody, sig))) return { status: 401, body: { error: "bad or missing X-Hermes-Signature-256" } };
    let env: HermesEnvelope;
    try { env = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid JSON" } }; }
    if (!freshTimestamp(env.timestamp)) return { status: 400, body: { error: "stale or missing timestamp" } };
    const limited = this.limit(1);
    if (limited) return limited;
    const sql = this.ctx.storage.sql;
    if (env.delivery_id) {
      const seen = sql.exec("SELECT 1 FROM deliveries WHERE id = ?", String(env.delivery_id).slice(0, 80)).toArray().length;
      if (seen) return { status: 200, body: { accepted: 0, duplicate: true } };
      sql.exec("INSERT INTO deliveries (id, at) VALUES (?, ?)", String(env.delivery_id).slice(0, 80), Date.now());
      if (Math.random() < 0.02) sql.exec("DELETE FROM deliveries WHERE at < ?", Date.now() - 3_600_000);
    }
    return { status: 200, body: this.store(mapHermes(env, this.cfg.privacy), 1) };
  }

  private store(raw: unknown[], received: number) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const accepted: ExtEvent[] = [];
    const rejected: { i: number; error: string }[] = [];
    raw.forEach((r, i) => {
      const v = validateEvent(r, now);
      if (!v.ok) { rejected.push({ i, error: v.error }); return; }
      const e = v.event;
      // never trust far-future clocks for ordering in the UI
      if (e.ts > now + 60_000) e.ts = now;
      const cur = sql.exec("INSERT OR IGNORE INTO events (ts, session, type, eid, body) VALUES (?, ?, ?, ?, ?) RETURNING seq", e.ts, e.session, e.type, e.id ?? null, JSON.stringify(e)).toArray() as { seq: number }[];
      if (!cur.length) return; // duplicate id
      const full = { ...e, seq: cur[0].seq } as ExtEvent;
      accepted.push(full);
      this.trackSession(full);
    });
    if (accepted.length) {
      sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('last', ?)", String(now));
      const n = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
      if (n > MAX_EVENTS) sql.exec("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq LIMIT ?)", PRUNE);
      this.broadcast(accepted);
      void this.touchAlarm();
    }
    return { received, accepted: accepted.length, rejected: rejected.slice(0, 20), lastSeq: accepted.at(-1)?.seq };
  }

  private trackSession(e: ExtEvent) {
    const sql = this.ctx.storage.sql;
    if (e.type === "subagent.start") {
      const d = e.data as { id: string; child_session?: string };
      sql.exec("INSERT OR REPLACE INTO children (child, parent) VALUES (?, ?)", d.child_session ?? d.id, e.session);
    }
    if (sql.exec("SELECT 1 FROM children WHERE child = ?", e.session).toArray().length) return;
    const d = e.data as Record<string, unknown>;
    const status = e.type === "session.end" ? ((d.final ? "ended" : "idle") as string) : e.type === "session.start" ? "idle" : "working";
    sql.exec(
      `INSERT INTO sessions (id, first_ts, last_ts, n, model, platform, status) VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts), first_ts = MIN(first_ts, excluded.first_ts), n = n + 1,
       model = COALESCE(sessions.model, excluded.model), platform = COALESCE(sessions.platform, excluded.platform), status = excluded.status`,
      e.session, e.ts, e.ts, typeof d.model === "string" ? d.model : null, typeof d.platform === "string" ? d.platform : null, status,
    );
  }

  private broadcast(events: ExtEvent[]) {
    const msg = JSON.stringify({ type: "events", events });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closed */ }
    }
  }

  async events(token: string, after: number, session: string, limit: number) {
    if (!(await this.who(token))) return { status: 401, body: { error: "a view or ingest token is required" } };
    const sql = this.ctx.storage.sql;
    let rows: { body: string; seq: number }[];
    if (session) {
      // a session's events plus those of its subagents' own sessions
      rows = sql.exec<{ body: string; seq: number }>(
        "SELECT body, seq FROM events WHERE seq > ? AND (session = ? OR session IN (SELECT child FROM children WHERE parent = ?)) ORDER BY seq LIMIT ?",
        after, session, session, limit,
      ).toArray();
    } else rows = sql.exec<{ body: string; seq: number }>("SELECT body, seq FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray();
    const events = rows.map((r) => ({ ...JSON.parse(r.body), seq: r.seq }));
    const last = sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM events").one().m ?? 0;
    return { status: 200, body: { events, lastSeq: last, more: rows.length === limit } };
  }

  async meta(token: string) {
    const who = await this.who(token);
    if (!who || !this.cfg) return { status: 401, body: { error: "a view or ingest token is required" } };
    const sql = this.ctx.storage.sql;
    const sessions = sql.exec("SELECT id, first_ts AS firstTs, last_ts AS lastTs, n, model, platform, status FROM sessions ORDER BY last_ts DESC LIMIT 50").toArray();
    const total = sql.exec<{ n: number; m: number | null }>("SELECT COUNT(*) AS n, MAX(seq) AS m FROM events").one();
    const last = Number(sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last'").toArray()[0]?.v ?? 0);
    return { status: 200, body: { id: this.cfg.id, agent: this.cfg.agent, name: this.cfg.name, privacy: this.cfg.privacy, createdAt: this.cfg.createdAt, lastActivity: last, events: total.n, lastSeq: total.m ?? 0, sessions, role: who, viewers: this.ctx.getWebSockets().length } };
  }

  async share(token: string) {
    if ((await this.who(token)) !== "ingest" || !this.cfg) return { status: 401, body: { error: "the ingest token is required" } };
    return { status: 200, body: { viewToken: this.cfg.viewToken } };
  }

  /** WebSocket stream (hibernatable): sends the backlog after ?after=, then live batches. */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const who = await this.who(url.searchParams.get("v") ?? "");
    if (!who) return new Response("unauthorized", { status: 401 });
    if (this.ctx.getWebSockets().length >= MAX_WS) return new Response("too many viewers", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    const rows = this.ctx.storage.sql.exec<{ body: string; seq: number }>("SELECT body, seq FROM events WHERE seq > ? ORDER BY seq LIMIT 2000", after).toArray();
    server.send(JSON.stringify({ type: "hello", office: this.cfg?.id, lastSeq: rows.at(-1)?.seq ?? after }));
    if (rows.length) server.send(JSON.stringify({ type: "events", events: rows.map((r) => ({ ...JSON.parse(r.body), seq: r.seq })) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong"); // keepalive; viewers never send events
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
  }

  private async touchAlarm(force = false) {
    const now = Date.now();
    if (!force && now - this.alarmAt < 3_600_000) return;
    this.alarmAt = now;
    const days = Math.max(1, Number(this.env.EXT_TTL_DAYS ?? 30) || 30);
    await this.ctx.storage.setAlarm(now + days * 86_400_000);
  }

  async alarm() {
    const days = Math.max(1, Number(this.env.EXT_TTL_DAYS ?? 30) || 30);
    const last = Number(this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last'").toArray()[0]?.v ?? 0);
    if (Date.now() - last >= days * 86_400_000) {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(1001, "office expired"); } catch { /* */ }
      await this.ctx.storage.deleteAll();
      this.cfg = null;
    } else await this.ctx.storage.setAlarm(last + days * 86_400_000);
  }
}

export type { ExtEventIn };
