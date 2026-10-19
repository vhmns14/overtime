// Remote control for external-agent offices (opt-in, off by default):
//   - remote approvals: the Hermes plugin registers a pending gateway approval, a paired device
//     answers it, the plugin long-polls for the signed decision and resolves it inside Hermes
//   - tasks: a paired device queues a prompt, the plugin claims it and starts a run through
//     Hermes' own API server (POST /v1/runs)
//   - notifications: Telegram (the user's own bot) and Web Push (VAPID) when Hermes needs the user
//   - a hash-chained, ECDSA-signed audit log of every control action
//
// ControlOffice extends the office Durable Object (worker/src/ext.ts) and is exported under the same
// class name, so no migration is needed and the event pipeline stays untouched.

import { ExtOffice, EXT_CORS, type ExtEnv } from "./ext";
import { json } from "./lib";
import type { ExtEvent } from "../../src/ext/schema";
import { OFFICE_ID, bearer, sha256Hex } from "../../src/ext/auth";
import { redactString } from "../../src/ext/redact";
import { spendNow } from "../../src/insights/aggregate";
import { insightEvents } from "./insights";
import {
  LIMITS_CONTROL, REMOTE_CHOICES, auditHash, cleanDeviceName, controlToken, isChoice, newAuditKeys, pairingCode, randomId, signAudit,
  signCommand, signDecision, validatePrompt, verifyAudit,
  type ApprovalStatus, type ApprovalView, type AuditEntry, type CommandStatus, type CommandView, type DeviceView,
} from "../../src/ext/control";
import {
  DEFAULT_NOTIFY, TELEGRAM_CHAT, TELEGRAM_TOKEN, budgetCandidate, candidatesFor, tzOffsetMin, parseNotifySettings, pushEndpointAllowed, shouldSend, telegramBody, toMessage,
  type Candidate, type Message, type NotifySettings, type SentLog,
} from "../../src/ext/notify";
import { buildPushRequest, generateVapidKeys, open as openBox, seal, vapidFromEnv, type PushSubscriptionJSON, type VapidKeys } from "../../src/ext/webpush";

export interface ControlEnv extends ExtEnv {
  /** master key for settings at rest (Telegram bot token). Without it each office keeps its own random key. */
  OVERTIME_SECRET_KEY?: string;
  /** public base URL used in notification links (default: the origin remote control was enabled from) */
  PUBLIC_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** self-host: a server-wide Telegram bot, used only by the offices listed in OVERTIME_TELEGRAM_OFFICES ("*" = all) */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  OVERTIME_TELEGRAM_OFFICES?: string;
  /** tests and local mocks only */
  TELEGRAM_API_BASE?: string;
}

interface Policy { remoteApproval: boolean; remoteTasks: boolean }
const DEFAULT_POLICY: Policy = { remoteApproval: false, remoteTasks: false };

type R = { status: number; body: unknown };
interface ControlReq { op: string; token: string; id?: string; wait?: number; body?: Record<string, any>; origin: string }

const OPS: Record<string, { method: "GET" | "POST"; re: RegExp }> = {
  state: { method: "GET", re: /^state$/ },
  enable: { method: "POST", re: /^enable$/ },
  pair: { method: "POST", re: /^devices$/ },
  claim: { method: "POST", re: /^devices\/claim$/ },
  revoke: { method: "POST", re: /^devices\/([\w-]+)\/revoke$/ },
  policy: { method: "POST", re: /^policy$/ },
  "approval.create": { method: "POST", re: /^approvals$/ },
  "approval.get": { method: "GET", re: /^approvals\/([\w-]+)$/ },
  "approval.decide": { method: "POST", re: /^approvals\/([\w-]+)\/decide$/ },
  "approval.outcome": { method: "POST", re: /^approvals\/([\w-]+)\/outcome$/ },
  "command.create": { method: "POST", re: /^commands$/ },
  "command.next": { method: "GET", re: /^commands\/next$/ },
  "command.ack": { method: "POST", re: /^commands\/([\w-]+)\/ack$/ },
  "command.cancel": { method: "POST", re: /^commands\/([\w-]+)\/cancel$/ },
  "notify.set": { method: "POST", re: /^notify$/ },
  "notify.test": { method: "POST", re: /^notify\/test$/ },
  "push.subscribe": { method: "POST", re: /^push\/subscribe$/ },
  "push.unsubscribe": { method: "POST", re: /^push\/unsubscribe$/ },
  audit: { method: "GET", re: /^audit$/ },
};

const stubOf = (env: ExtEnv, id: string) => env.EXT_OFFICES.get(env.EXT_OFFICES.idFromName(id)) as unknown as { control(r: ControlReq): Promise<R> };
const ok = (data: unknown, status = 200) => json(data, status, EXT_CORS);

/** Routes /api/ext/runs/:id/control/*. Returns null when the path is not ours. */
export async function handleControl(req: Request, env: ExtEnv, url: URL): Promise<Response | null> {
  const m = url.pathname.match(/^\/api\/ext\/runs\/([^/]+)\/control\/(.+)$/);
  if (!m) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: EXT_CORS });
  const [, office, rest] = m;
  if (!OFFICE_ID.test(office)) return ok({ error: "unknown office" }, 404);
  const hit = Object.entries(OPS).find(([, o]) => o.re.test(rest));
  if (!hit) return ok({ error: "not found" }, 404);
  const [op, spec] = hit;
  if (req.method !== spec.method) return ok({ error: "method not allowed" }, 405);
  let body: Record<string, any> | undefined;
  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") ?? "0") > 16_384) return ok({ error: "body too large" }, 413);
    const text = await req.text();
    if (text.length > 16_384) return ok({ error: "body too large" }, 413);
    try { body = text ? JSON.parse(text) : {}; } catch { return ok({ error: "invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return ok({ error: "expected a JSON object" }, 400);
  }
  const wait = Math.max(0, Math.min(LIMITS_CONTROL.maxWaitS, Number(url.searchParams.get("wait") ?? 0) || 0));
  const r = await stubOf(env, office).control({ op, token: bearer(req), id: rest.match(spec.re)?.[1], wait, body, origin: env && (env as ControlEnv).PUBLIC_URL ? String((env as ControlEnv).PUBLIC_URL).replace(/\/+$/, "") : url.origin });
  return ok(r.body, r.status);
}

const now = () => Date.now();
/** how long a pairing link works, once */
export const PAIRING_TTL_MS = 10 * 60_000;
/** rows kept per control table (newest first); pending approvals and open tasks are never pruned */
export const CONTROL_CAPS = { audit: 5000, sent: 2000, approvals: 500, commands: 500, devices: 50 };
/** an approval command longer than this cannot be shown in full, so it can only be denied remotely */
export const APPROVAL_SHOW_CHARS = 4000;
const clip = (s: unknown, n: number) => { const t = typeof s === "string" ? s : ""; return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export class ControlOffice extends ExtOffice {
  private waiters = new Map<string, Set<() => void>>();
  private lastSeenWrite = new Map<string, number>();
  /** in-flight notification deliveries (tests await them) */
  readonly outbox: Promise<unknown>[] = [];
  /** audit entries are appended one at a time: concurrent appends would reuse a seq and fork the chain */
  private auditTail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_approvals (id TEXT PRIMARY KEY, session TEXT NOT NULL, surface TEXT NOT NULL, command TEXT NOT NULL, command_sha TEXT NOT NULL, description TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, choice TEXT, by_device TEXT, decided_at INTEGER, sig TEXT, outcome TEXT)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_commands (id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT NOT NULL, target TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, by_device TEXT NOT NULL, claimed_at INTEGER, run_id TEXT, error TEXT, updated INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, by_name TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL, sig TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_push (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT NOT NULL, created INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_sent (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL, trig TEXT NOT NULL, result TEXT NOT NULL)");
      // one-time pairing codes (hashed): a pairing link is good for one device, for PAIRING_TTL_MS
      sql.exec("CREATE TABLE IF NOT EXISTS ctl_pairings (hash TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, by_name TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
      // approvals whose command could not be shown in full (truncated) or had parts hidden as secrets
      if (!sql.exec<{ name: string }>("PRAGMA table_info(ctl_approvals)").toArray().some((c) => c.name === "flags")) sql.exec("ALTER TABLE ctl_approvals ADD COLUMN flags TEXT");
    });
  }

  private get cenv() { return this.env as ControlEnv; }

  // ---------- small storage helpers ----------
  private kv<T>(k: string, d: T): T {
    const row = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM ctl_kv WHERE k = ?", k).toArray()[0];
    if (!row) return d;
    try { return JSON.parse(row.v) as T; } catch { return d; }
  }
  private setKv(k: string, v: unknown) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO ctl_kv (k, v) VALUES (?, ?)", k, JSON.stringify(v)); }
  private policy(): Policy { return { ...DEFAULT_POLICY, ...this.kv<Partial<Policy>>("policy", {}) }; }
  private notifySettings(): NotifySettings { return parseNotifySettings(this.kv("notify", DEFAULT_NOTIFY)); }

  private wake(key: string) {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    for (const f of set) f();
  }
  private waitFor(key: string, seconds: number): Promise<void> {
    if (seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      const done = () => { clearTimeout(t); set.delete(done); resolve(); };
      const t = setTimeout(done, seconds * 1000);
      set.add(done);
      this.waiters.set(key, set);
    });
  }
  /** content-free ping: clients holding a control token refetch /control/state */
  private ping() {
    const rev = this.kv("rev", 0) + 1;
    this.setKv("rev", rev);
    const msg = JSON.stringify({ type: "control", rev });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* closed */ } }
  }

  // ---------- auth ----------
  private async device(token: string): Promise<{ id: string; name: string } | null> {
    if (!token.startsWith("ot_ctl_")) return null;
    const h = await sha256Hex(token);
    const row = this.ctx.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM ctl_devices WHERE hash = ? AND revoked = 0", h).toArray()[0];
    if (!row) return null;
    const t = now();
    if (t - (this.lastSeenWrite.get(row.id) ?? 0) > 60_000) {
      this.lastSeenWrite.set(row.id, t);
      this.ctx.storage.sql.exec("UPDATE ctl_devices SET last_seen = ? WHERE id = ?", t, row.id);
    }
    return row;
  }
  private activeDevices(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ctl_devices WHERE revoked = 0").one().n;
  }

  // ---------- audit ----------
  private async auditKeys(): Promise<{ privateJwk: JsonWebKey; publicKey: string }> {
    let k = this.kv<{ privateJwk: JsonWebKey; publicKey: string } | null>("audit_keys", null);
    if (!k) { k = await newAuditKeys(); this.setKv("audit_keys", k); }
    return k;
  }
  private audit(kind: string, subject: string, detail: string, by: string): Promise<void> {
    const run = this.auditTail.then(() => this.appendAudit(kind, subject, detail, by));
    this.auditTail = run.catch(() => undefined);
    return run;
  }
  private async appendAudit(kind: string, subject: string, detail: string, by: string) {
    const keys = await this.auditKeys();
    const sql = this.ctx.storage.sql;
    const last = sql.exec<{ seq: number; hash: string }>("SELECT seq, hash FROM ctl_audit ORDER BY seq DESC LIMIT 1").toArray()[0];
    const e = { seq: (last?.seq ?? 0) + 1, at: now(), kind, subject: clip(subject, 80), detail: clip(redactString(detail), 200), by: clip(by, 60), prev: last?.hash ?? "genesis" };
    const hash = await auditHash(e);
    const sig = await signAudit(keys.privateJwk, hash);
    sql.exec("INSERT INTO ctl_audit (seq, at, kind, subject, detail, by_name, prev, hash, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", e.seq, e.at, e.kind, e.subject, e.detail, e.by, e.prev, hash, sig);
    if (e.seq % 50 === 0) this.pruneControl();
  }

  /** Storage caps for the control tables (an office lives for months; nothing here may grow without bound). */
  pruneControl(t = now()) {
    const sql = this.ctx.storage.sql;
    const C = CONTROL_CAPS;
    sql.exec("DELETE FROM ctl_audit WHERE seq <= (SELECT MAX(seq) FROM ctl_audit) - ?", C.audit);
    sql.exec("DELETE FROM ctl_sent WHERE id <= (SELECT MAX(id) FROM ctl_sent) - ?", C.sent);
    sql.exec("DELETE FROM ctl_approvals WHERE status != 'pending' AND id NOT IN (SELECT id FROM ctl_approvals ORDER BY created DESC LIMIT ?)", C.approvals);
    sql.exec("DELETE FROM ctl_commands WHERE status NOT IN ('queued','claimed','started') AND id NOT IN (SELECT id FROM ctl_commands ORDER BY created DESC LIMIT ?)", C.commands);
    sql.exec("DELETE FROM ctl_pairings WHERE expires < ? OR used = 1", t - 86_400_000);
    sql.exec("DELETE FROM ctl_devices WHERE revoked = 1 AND id NOT IN (SELECT id FROM ctl_devices ORDER BY created DESC LIMIT ?)", C.devices);
  }
  private auditRows(limit = 200): AuditEntry[] {
    return this.ctx.storage.sql.exec<Record<string, any>>("SELECT seq, at, kind, subject, detail, by_name, prev, hash, sig FROM ctl_audit ORDER BY seq DESC LIMIT ?", limit).toArray()
      .map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, subject: r.subject, detail: r.detail, by: r.by_name, prev: r.prev, hash: r.hash, sig: r.sig })).reverse();
  }

  // ---------- the RPC entry point ----------
  async control(r: ControlReq): Promise<R> {
    if (!this.cfg) return { status: 404, body: { error: "unknown office" } };
    const who = await this.who(r.token);
    const dev = who ? null : await this.device(r.token);
    const ingest = who === "ingest";
    const needDevice = (): R | null => (dev ? null : { status: 401, body: { error: who === "view" ? "the viewer link is read-only; a paired device's control token is required" : "a control token (ot_ctl_…) is required" } });
    const needIngest = (): R | null => (ingest ? null : { status: 401, body: { error: "the office's ingest token is required" } });
    const b = r.body ?? {};
    this.expireApprovals();

    switch (r.op) {
      case "enable": {
        const bad = needIngest();
        if (bad) return bad;
        if (this.activeDevices() > 0) return { status: 409, body: { error: "remote control is already paired with a device; pair new devices from a paired one" } };
        const name = cleanDeviceName(b.device);
        const out = await this.addDevice(name);
        this.setKv("origin", r.origin);
        await this.audit("control.enabled", out.deviceId, name, name);
        this.ping();
        return { status: 201, body: { ...out, policy: this.policy() } };
      }
      case "pair": {
        // a one-time pairing code, not a device token: the link works once, for PAIRING_TTL_MS, and
        // the new device gets its own control token when it claims it (a leaked old link is worthless)
        const bad = needDevice();
        if (bad) return bad;
        if (this.activeDevices() >= LIMITS_CONTROL.maxDevices) return { status: 409, body: { error: `at most ${LIMITS_CONTROL.maxDevices} devices` } };
        const t = now();
        this.ctx.storage.sql.exec("DELETE FROM ctl_pairings WHERE expires < ? OR used = 1", t);
        const open = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ctl_pairings").one().n;
        if (open >= 5) return { status: 429, body: { error: "too many unused pairing links; wait for them to expire" } };
        const name = cleanDeviceName(b.name);
        const code = pairingCode();
        const expiresAt = t + PAIRING_TTL_MS;
        this.ctx.storage.sql.exec("INSERT INTO ctl_pairings (hash, name, created, expires, by_name) VALUES (?, ?, ?, ?, ?)", await sha256Hex(code), name, t, expiresAt, dev!.name);
        await this.audit("device.pairing", "pairing", `link for ${name}, valid 10 min, once`, dev!.name);
        return { status: 201, body: { pairingCode: code, deviceName: name, expiresAt, watch: `${r.origin}/watch/${this.cfg.id}#v=${this.cfg.viewToken}&p=${code}` } };
      }
      case "claim": {
        // no token: the pairing code in the body is the credential
        const code = typeof b.code === "string" ? b.code : "";
        if (!/^ot_pair_[\w-]{16,}$/.test(code)) return { status: 400, body: { error: "a pairing code (ot_pair_…) is required" } };
        const h = await sha256Hex(code);
        const t = now();
        const row = this.ctx.storage.sql.exec<{ name: string; by_name: string }>("UPDATE ctl_pairings SET used = 1 WHERE hash = ? AND used = 0 AND expires >= ? RETURNING name, by_name", h, t).toArray()[0];
        if (!row) return { status: 410, body: { error: "this pairing link was already used or has expired; make a new one on a paired device" } };
        if (this.activeDevices() >= LIMITS_CONTROL.maxDevices) return { status: 409, body: { error: `at most ${LIMITS_CONTROL.maxDevices} devices` } };
        const out = await this.addDevice(row.name);
        await this.audit("device.added", out.deviceId, row.name, row.by_name);
        this.ping();
        return { status: 201, body: out };
      }
      case "revoke": {
        const bad = needDevice();
        if (bad) return bad;
        const row = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM ctl_devices WHERE id = ? AND revoked = 0", r.id ?? "").toArray()[0];
        if (!row) return { status: 404, body: { error: "unknown device" } };
        this.ctx.storage.sql.exec("UPDATE ctl_devices SET revoked = 1 WHERE id = ?", r.id!);
        this.ctx.storage.sql.exec("DELETE FROM ctl_push WHERE device = ?", r.id!);
        await this.audit("device.revoked", r.id!, row.name, dev!.name);
        this.ping();
        return { status: 200, body: { ok: true } };
      }
      case "policy": {
        const bad = needDevice();
        if (bad) return bad;
        const p = this.policy();
        const next: Policy = { remoteApproval: typeof b.remoteApproval === "boolean" ? b.remoteApproval : p.remoteApproval, remoteTasks: typeof b.remoteTasks === "boolean" ? b.remoteTasks : p.remoteTasks };
        this.setKv("policy", next);
        await this.audit("policy.changed", "policy", `approvals ${next.remoteApproval ? "on" : "off"}, tasks ${next.remoteTasks ? "on" : "off"}`, dev!.name);
        this.ping();
        return { status: 200, body: { policy: next } };
      }
      case "state": {
        const bad = needDevice();
        if (bad) return bad;
        return { status: 200, body: await this.state(dev!.id) };
      }

      // ----- approvals -----
      case "approval.create": {
        const bad = needIngest();
        if (bad) return bad;
        if (!this.policy().remoteApproval) return { status: 409, body: { error: "remote approval is off in Overtime", code: "remote_approval_off" } };
        const id = typeof b.request_id === "string" && /^[\w-]{8,64}$/.test(b.request_id) ? b.request_id : null;
        if (!id) return { status: 400, body: { error: "request_id must be 8-64 word characters" } };
        if (typeof b.command !== "string" || !b.command) return { status: 400, body: { error: "command is required" } };
        if (this.ctx.storage.sql.exec("SELECT 1 FROM ctl_approvals WHERE id = ?", id).toArray().length) return { status: 409, body: { error: "duplicate request_id" } };
        const commandSha = await sha256Hex(b.command);
        const shown = redactString(b.command);
        const flags = [...(b.command.length > APPROVAL_SHOW_CHARS ? ["truncated"] : []), ...(shown !== b.command ? ["redacted"] : [])].join(",") || null;
        const ttl = Math.max(10, Math.min(LIMITS_CONTROL.approvalMaxS, Number(b.expires_in) || 120));
        const t = now();
        const session = typeof b.session === "string" ? clip(b.session, 128) : "default";
        const surface = typeof b.surface === "string" ? clip(b.surface, 16) : "gateway";
        this.ctx.storage.sql.exec(
          "INSERT INTO ctl_approvals (id, session, surface, command, command_sha, description, created, expires, status, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          id, session, surface, clip(shown, APPROVAL_SHOW_CHARS), commandSha, clip(redactString(String(b.description ?? "")), 300), t, t + ttl * 1000, flags,
        );
        await this.audit("approval.requested", id, clip(String(b.description ?? b.command), 120), "hermes");
        this.ping();
        return { status: 201, body: { id, expiresAt: t + ttl * 1000, commandSha } };
      }
      case "approval.get": {
        const bad = needIngest();
        if (bad) return bad;
        let row = this.approvalRow(r.id!);
        if (!row) return { status: 404, body: { error: "unknown approval" } };
        if (row.status === "pending" && r.wait) {
          await this.waitFor(`approval:${r.id}`, Math.min(r.wait, Math.max(0, (row.expires - now()) / 1000)));
          this.expireApprovals();
          row = this.approvalRow(r.id!)!;
        }
        const decided = row.choice && row.sig ? { request_id: row.id, command_sha256: row.command_sha, choice: row.choice, by: row.by_device, at: row.decided_at, sig: row.sig } : null;
        return { status: 200, body: { id: row.id, status: row.status, decision: decided } };
      }
      case "approval.decide": {
        const bad = needDevice();
        if (bad) return bad;
        if (!this.policy().remoteApproval) return { status: 409, body: { error: "remote approval is off" } };
        if (!isChoice(b.choice)) return { status: 400, body: { error: `choice must be one of ${REMOTE_CHOICES.join(", ")} ("always" is only possible in Hermes itself)` } };
        const row = this.approvalRow(r.id!);
        if (!row) return { status: 404, body: { error: "unknown approval" } };
        if (row.status !== "pending") return { status: row.status === "expired" ? 410 : 409, body: { error: `already ${row.status}`, status: row.status } };
        // what you cannot see in full you cannot approve: a truncated command can only be denied here
        if (b.choice !== "deny" && String(row.flags ?? "").split(",").includes("truncated")) return { status: 409, body: { error: "this command is too long to show in full; approve it in Hermes itself (you can deny it here)", code: "truncated" } };
        const at = now();
        const sig = await signDecision(this.cfg.ingestHash, this.cfg.id, row.id, row.command_sha, b.choice, dev!.name, at);
        // the first answer wins: a concurrent second answer (another device) is refused, never reported as applied
        const won = this.ctx.storage.sql.exec("UPDATE ctl_approvals SET status = 'decided', choice = ?, by_device = ?, decided_at = ?, sig = ? WHERE id = ? AND status = 'pending' RETURNING id", b.choice, cleanDeviceName(dev!.name), at, sig, row.id).toArray();
        if (!won.length) { const cur = this.approvalRow(row.id); return { status: 409, body: { error: `already ${cur?.status ?? "answered"}`, status: cur?.status } }; }
        await this.audit("approval.decided", row.id, `${b.choice === "deny" ? "Denied" : b.choice === "session" ? "Approved for the session" : "Approved once"}: ${clip(row.description || row.command, 100)}`, dev!.name);
        this.wake(`approval:${row.id}`);
        this.ping();
        return { status: 200, body: { ok: true, status: "decided", choice: b.choice, by: cleanDeviceName(dev!.name), at } };
      }
      case "approval.outcome": {
        const bad = needIngest();
        if (bad) return bad;
        const row = this.approvalRow(r.id!);
        if (!row) return { status: 404, body: { error: "unknown approval" } };
        const outcome = ["applied", "stale", "timeout", "answered_locally", "unsupported"].includes(b.outcome) ? (b.outcome as string) : null;
        if (!outcome) return { status: 400, body: { error: "outcome must be applied, stale, timeout, answered_locally or unsupported" } };
        if (["applied", "stale", "timeout", "answered_locally"].includes(row.status)) return { status: 200, body: { ok: true, status: row.status } };
        if (outcome === "applied" && row.status !== "decided") return { status: 409, body: { error: "nothing was decided" } };
        const status: ApprovalStatus = outcome === "unsupported" ? "stale" : (outcome as ApprovalStatus);
        this.ctx.storage.sql.exec("UPDATE ctl_approvals SET status = ?, outcome = ? WHERE id = ?", status, clip(String(b.detail ?? outcome), 120), row.id);
        await this.audit(`approval.${status}`, row.id, outcome === "applied" ? String(row.choice) : clip(String(b.detail ?? ""), 100), "hermes");
        this.wake(`approval:${row.id}`);
        this.ping();
        return { status: 200, body: { ok: true, status } };
      }

      // ----- tasks -----
      case "command.create": {
        const bad = needDevice();
        if (bad) return bad;
        if (!this.policy().remoteTasks) return { status: 409, body: { error: "sending tasks is off in Overtime", code: "remote_tasks_off" } };
        const kind = b.kind === "stop" ? "stop" : b.kind === "run" || b.kind === undefined ? "run" : null;
        if (!kind) return { status: 400, body: { error: "kind must be run or stop" } };
        if (b.confirm !== true) return { status: 400, body: { error: "confirm: true is required (the UI asks first)" } };
        const open = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ctl_commands WHERE status IN ('queued','claimed')").one().n;
        if (open >= LIMITS_CONTROL.openCommands) return { status: 429, body: { error: "too many tasks waiting for Hermes" } };
        let prompt = "";
        let target: string | null = null;
        if (kind === "run") {
          const v = validatePrompt(b.prompt);
          if (!v.ok) return { status: 400, body: { error: v.error } };
          prompt = v.prompt;
        } else {
          const t = this.ctx.storage.sql.exec<{ run_id: string | null; status: string }>("SELECT run_id, status FROM ctl_commands WHERE id = ? AND kind = 'run'", String(b.target ?? "")).toArray()[0];
          if (!t || t.status !== "started" || !t.run_id) return { status: 409, body: { error: "only a running task started from Overtime can be stopped" } };
          target = String(b.target);
          prompt = t.run_id;
        }
        const id = randomId("cmd", 10);
        const t = now();
        this.ctx.storage.sql.exec("INSERT INTO ctl_commands (id, kind, prompt, target, status, created, by_device, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)", id, kind, prompt, target, t, cleanDeviceName(dev!.name), t);
        await this.audit("command.queued", id, kind === "run" ? clip(prompt, 120) : `stop ${target}`, dev!.name);
        this.wake("commands");
        this.ping();
        return { status: 201, body: { id, status: "queued" } };
      }
      case "command.next": {
        const bad = needIngest();
        if (bad) return bad;
        if (!this.policy().remoteTasks) return { status: 200, body: { command: null, off: true } };
        this.loseStaleClaims();
        let c = this.nextQueued();
        if (!c && r.wait) { await this.waitFor("commands", r.wait); c = this.nextQueued(); }
        if (!c) return { status: 200, body: { command: null } };
        const t = now();
        const res = this.ctx.storage.sql.exec("UPDATE ctl_commands SET status = 'claimed', claimed_at = ?, updated = ? WHERE id = ? AND status = 'queued' RETURNING id", t, t, c.id).toArray();
        if (!res.length) return { status: 200, body: { command: null } };
        await this.audit("command.claimed", c.id, c.kind, "hermes");
        this.ping();
        const sig = await signCommand(this.cfg.ingestHash, this.cfg.id, c.id, c.kind as "run" | "stop", c.prompt, c.created);
        return { status: 200, body: { command: { id: c.id, kind: c.kind, payload: c.prompt, created_at: c.created, by: c.by_device, sig } } };
      }
      case "command.ack": {
        const bad = needIngest();
        if (bad) return bad;
        const c = this.ctx.storage.sql.exec<{ status: CommandStatus; kind: string; target: string | null }>("SELECT status, kind, target FROM ctl_commands WHERE id = ?", r.id ?? "").toArray()[0];
        if (!c) return { status: 404, body: { error: "unknown task" } };
        const st = String(b.status ?? "") as CommandStatus;
        const allowed: Record<string, CommandStatus[]> = { claimed: ["started", "rejected", "failed", "completed"], started: ["completed", "failed", "cancelled"], lost: ["started", "completed", "failed", "cancelled"] };
        if (!(allowed[c.status] ?? []).includes(st)) return { status: 409, body: { error: `cannot go from ${c.status} to ${st}` } };
        const runId = typeof b.run_id === "string" ? clip(b.run_id, 80) : null;
        this.ctx.storage.sql.exec("UPDATE ctl_commands SET status = ?, run_id = COALESCE(?, run_id), error = ?, updated = ? WHERE id = ?", st, runId, b.error ? clip(redactString(String(b.error)), 300) : null, now(), r.id!);
        await this.audit(`command.${st}`, r.id!, clip(String(b.error ?? runId ?? ""), 100), "hermes");
        this.ping();
        return { status: 200, body: { ok: true } };
      }
      case "command.cancel": {
        const bad = needDevice();
        if (bad) return bad;
        const res = this.ctx.storage.sql.exec("UPDATE ctl_commands SET status = 'cancelled', updated = ? WHERE id = ? AND status = 'queued' RETURNING id", now(), r.id ?? "").toArray();
        if (!res.length) return { status: 409, body: { error: "only a task Hermes has not picked up yet can be cancelled here" } };
        await this.audit("command.cancelled", r.id!, "", dev!.name);
        this.ping();
        return { status: 200, body: { ok: true } };
      }

      // ----- notifications -----
      case "notify.set": {
        const bad = needDevice();
        if (bad) return bad;
        const s = parseNotifySettings(b.settings ?? {}, this.notifySettings());
        this.setKv("notify", s);
        if (b.telegram && typeof b.telegram === "object") {
          if (b.telegram.clear) this.setKv("telegram", null);
          else if (b.telegram.useServer === true) {
            if (!this.serverTelegram()) return { status: 409, body: { error: "this deployment has no server-wide Telegram bot for this office" } };
            this.setKv("telegram", { server: true });
          } else {
            const token = String(b.telegram.token ?? "").trim();
            const chat = String(b.telegram.chatId ?? "").trim();
            if (!TELEGRAM_TOKEN.test(token)) return { status: 400, body: { error: "that does not look like a Telegram bot token (123456:ABC…)" } };
            if (!TELEGRAM_CHAT.test(chat)) return { status: 400, body: { error: "chat id must be a number (e.g. 123456789 or -100…) or @channelname" } };
            this.setKv("telegram", { sealed: await seal(await this.masterKey(), `telegram:${this.cfg.id}`, token), chatId: chat, tail: token.slice(-4) });
          }
        }
        this.setKv("origin", r.origin);
        await this.audit("notify.changed", "notify", `${s.enabled ? "on" : "off"}; ${Object.entries(s.triggers).filter(([, v]) => v).map(([k]) => k).join(", ") || "no triggers"}${s.quiet.on ? `; quiet ${s.quiet.start}-${s.quiet.end} ${s.quiet.tz}` : ""}`, dev!.name);
        this.ping();
        return { status: 200, body: { ok: true, settings: s } };
      }
      case "notify.test": {
        const bad = needDevice();
        if (bad) return bad;
        const c: Candidate = { trigger: "approval", key: `test:${now()}`, session: "test", title: "Overtime test notification", body: "Notifications from your Hermes office work." };
        const results = await this.deliver(c, { force: true, channel: typeof b.channel === "string" ? b.channel : undefined });
        return { status: 200, body: { results } };
      }
      case "push.subscribe": {
        const bad = needDevice();
        if (bad) return bad;
        const s = b.subscription as PushSubscriptionJSON | undefined;
        if (!s || typeof s.endpoint !== "string" || !pushEndpointAllowed(s.endpoint)) return { status: 400, body: { error: "push endpoint must be a browser push service (https)" } };
        if (typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string" || s.keys.p256dh.length > 120 || s.keys.auth.length > 40) return { status: 400, body: { error: "bad subscription keys" } };
        const n = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ctl_push").one().n;
        if (n >= 20) return { status: 409, body: { error: "too many push subscriptions" } };
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO ctl_push (endpoint, p256dh, auth, device, created) VALUES (?, ?, ?, ?, ?)", s.endpoint, s.keys.p256dh, s.keys.auth, dev!.id, now());
        this.setKv("origin", r.origin);
        this.ping();
        return { status: 201, body: { ok: true } };
      }
      case "push.unsubscribe": {
        const bad = needDevice();
        if (bad) return bad;
        this.ctx.storage.sql.exec("DELETE FROM ctl_push WHERE endpoint = ?", String(b.endpoint ?? ""));
        this.ping();
        return { status: 200, body: { ok: true } };
      }
      case "audit": {
        const bad = needDevice();
        if (bad) return bad;
        const entries = this.auditRows();
        const keys = await this.auditKeys();
        const verified = await verifyAudit(entries, keys.publicKey);
        return { status: 200, body: { entries, publicKey: keys.publicKey, verified } };
      }
    }
    return { status: 404, body: { error: "not found" } };
  }

  private async addDevice(name: string) {
    const controlTokenValue = controlToken();
    const id = randomId("dev", 6);
    const t = now();
    this.ctx.storage.sql.exec("INSERT INTO ctl_devices (id, name, hash, created, last_seen) VALUES (?, ?, ?, ?, ?)", id, name, await sha256Hex(controlTokenValue), t, t);
    return { controlToken: controlTokenValue, deviceId: id, deviceName: name };
  }

  private approvalRow(id: string) {
    return this.ctx.storage.sql.exec<{ id: string; session: string; surface: string; command: string; command_sha: string; description: string; created: number; expires: number; status: ApprovalStatus; choice: string | null; by_device: string | null; decided_at: number | null; sig: string | null; outcome: string | null; flags: string | null }>(
      "SELECT * FROM ctl_approvals WHERE id = ?", id,
    ).toArray()[0];
  }

  private expireApprovals() {
    const t = now();
    const rows = this.ctx.storage.sql.exec<{ id: string }>("UPDATE ctl_approvals SET status = 'expired' WHERE status = 'pending' AND expires < ? RETURNING id", t).toArray();
    for (const r of rows) { this.audit("approval.expired", r.id, "", "overtime").catch(() => undefined); this.wake(`approval:${r.id}`); }
    if (rows.length) this.ping();
  }

  private loseStaleClaims() {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("UPDATE ctl_commands SET status = 'lost', updated = ? WHERE status = 'claimed' AND claimed_at < ? RETURNING id", now(), now() - LIMITS_CONTROL.commandLeaseMs).toArray();
    for (const r of rows) this.audit("command.lost", r.id, "never confirmed as started; not retried", "overtime").catch(() => undefined);
  }

  private nextQueued() {
    return this.ctx.storage.sql.exec<{ id: string; kind: string; prompt: string; created: number; by_device: string }>("SELECT id, kind, prompt, created, by_device FROM ctl_commands WHERE status = 'queued' ORDER BY created LIMIT 1").toArray()[0];
  }

  private async state(deviceId: string) {
    const sql = this.ctx.storage.sql;
    const approvals: ApprovalView[] = sql.exec<any>("SELECT * FROM ctl_approvals ORDER BY (status = 'pending') DESC, created DESC LIMIT 20").toArray().map((a) => ({
      id: a.id, session: a.session, surface: a.surface, command: a.command, description: a.description, createdAt: a.created, expiresAt: a.expires, status: a.status,
      choice: a.choice ?? undefined, by: a.by_device ?? undefined, decidedAt: a.decided_at ?? undefined, outcome: a.outcome ?? undefined,
      ...(String(a.flags ?? "").includes("truncated") ? { truncated: true } : {}), ...(String(a.flags ?? "").includes("redacted") ? { redacted: true } : {}),
    }));
    const commands: CommandView[] = sql.exec<any>("SELECT * FROM ctl_commands ORDER BY created DESC LIMIT 20").toArray().map((c) => ({
      id: c.id, kind: c.kind, prompt: c.kind === "run" ? c.prompt : "", target: c.target ?? undefined, status: c.status, createdAt: c.created, by: c.by_device, runId: c.run_id ?? undefined, error: c.error ?? undefined, updatedAt: c.updated,
    }));
    const devices: DeviceView[] = sql.exec<any>("SELECT id, name, created, last_seen FROM ctl_devices WHERE revoked = 0 ORDER BY created").toArray().map((d) => ({ id: d.id, name: d.name, createdAt: d.created, lastSeen: d.last_seen, current: d.id === deviceId }));
    const tg = this.kv<{ chatId?: string; tail?: string; server?: boolean } | null>("telegram", null);
    const pushCount = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ctl_push").one().n;
    const mine = sql.exec<{ endpoint: string }>("SELECT endpoint FROM ctl_push WHERE device = ?", deviceId).toArray().map((x) => x.endpoint);
    const sent = sql.exec<{ k: string; channel: string; at: number; trig: string; result: string }>("SELECT k, channel, at, trig, result FROM ctl_sent ORDER BY id DESC LIMIT 10").toArray();
    return {
      office: this.cfg!.id,
      policy: this.policy(),
      notify: this.notifySettings(),
      telegram: tg ? (tg.server ? { set: true, server: true } : { set: true, chatId: tg.chatId, tokenTail: tg.tail }) : { set: false, serverAvailable: !!this.serverTelegram() },
      push: { vapidPublicKey: (await this.vapid()).publicKey, subscriptions: pushCount, mine },
      devices,
      approvals,
      commands,
      sent,
      rev: this.kv("rev", 0),
    };
  }

  // ---------- notifications ----------
  private async masterKey(): Promise<string> {
    if (this.cenv.OVERTIME_SECRET_KEY) return this.cenv.OVERTIME_SECRET_KEY;
    let k = this.kv<string | null>("box_key", null);
    if (!k) { k = randomId("bk", 32); this.setKv("box_key", k); }
    return k;
  }
  private async vapid(): Promise<VapidKeys> {
    const env = vapidFromEnv(this.cenv.VAPID_PUBLIC_KEY, this.cenv.VAPID_PRIVATE_KEY);
    if (env) return env;
    let k = this.kv<VapidKeys | null>("vapid", null);
    if (!k) { k = await generateVapidKeys(); this.setKv("vapid", k); }
    return k;
  }
  private serverTelegram(): { token: string; chatId: string } | null {
    const e = this.cenv;
    if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_CHAT_ID) return null;
    const list = (e.OVERTIME_TELEGRAM_OFFICES ?? "").split(",").map((s) => s.trim());
    return list.includes("*") || list.includes(this.cfg?.id ?? "") ? { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID } : null;
  }
  private watchUrl(): string {
    const origin = this.cenv.PUBLIC_URL?.replace(/\/+$/, "") || this.kv("origin", "");
    return `${origin}/watch/${this.cfg!.id}#v=${this.cfg!.viewToken}`;
  }

  protected override onAccepted(events: ExtEvent[]): void {
    super.onAccepted(events);
    const s = this.notifySettings();
    if (!s.enabled) return;
    const titles = new Map<string, string>();
    for (const e of events) if (e.type === "message" && (e.data as { role?: string }).role === "user" && !titles.has(e.session)) titles.set(e.session, String((e.data as { text?: string }).text ?? ""));
    for (const c of candidatesFor(events, (sid) => titles.get(sid))) this.outbox.push(this.deliver(c).catch(() => undefined));
    if (s.triggers.stuck) this.outbox.push(this.scheduleAlarm().catch(() => undefined));
    if (s.triggers.budget && (s.budget.dailyUsd !== null || s.budget.monthlyUsd !== null) && events.some((e) => e.type === "llm.call")) this.outbox.push(this.checkBudget().catch(() => undefined));
  }

  // ---------- budgets (server side, so a notification needs no open tab) ----------
  /** Spend today / this month from the same events the insights route serves; notifies once per period. */
  async checkBudget(t = now()) {
    const s = this.notifySettings();
    if (!s.enabled || !s.triggers.budget) return;
    const spend = spendNow(insightEvents(this.ctx.storage.sql).events, { now: t, offsetMin: tzOffsetMin(t, s.quiet.tz) });
    const c = budgetCandidate(spend, s.budget);
    if (!c) return;
    const notified = this.kv<string[]>("budget_notified", []);
    if (notified.includes(c.key)) return;
    this.setKv("budget_notified", [...notified, c.key].slice(-24));
    await this.deliver(c);
  }

  /** Sends one notification on every configured channel that passes settings, quiet hours, dedupe and rate limits. */
  private async deliver(c: Candidate, opts: { force?: boolean; channel?: string } = {}): Promise<{ channel: string; ok: boolean; status?: number; reason?: string }[]> {
    const s = this.notifySettings();
    const sql = this.ctx.storage.sql;
    const t = now();
    const log = sql.exec<{ k: string; channel: string; at: number }>("SELECT k, channel, at FROM ctl_sent WHERE at > ?", t - Math.max(3_600_000, s.dedupeS * 1000)).toArray().map((r): SentLog => ({ key: r.k, channel: r.channel, at: r.at }));
    const msg: Message = toMessage(c, this.watchUrl());
    const out: { channel: string; ok: boolean; status?: number; reason?: string }[] = [];
    const record = (channel: string, result: string) => sql.exec("INSERT INTO ctl_sent (k, channel, at, trig, result) VALUES (?, ?, ?, ?, ?)", c.key, channel, t, c.trigger, result);

    const channels: { name: string; send: () => Promise<number> }[] = [];
    const tgCfg = this.kv<{ sealed?: string; chatId?: string; server?: boolean } | null>("telegram", null);
    if (tgCfg) {
      channels.push({ name: "telegram", send: async () => {
        let token: string | null = null;
        let chat = tgCfg.chatId ?? "";
        if (tgCfg.server) { const st = this.serverTelegram(); token = st?.token ?? null; chat = st?.chatId ?? ""; }
        else if (tgCfg.sealed) token = await openBox(await this.masterKey(), `telegram:${this.cfg!.id}`, tgCfg.sealed);
        if (!token || !chat) return 0;
        const base = (this.cenv.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
        const res = await fetch(`${base}/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(telegramBody(chat, msg)) });
        return res.status;
      } });
    }
    const subs = sql.exec<{ endpoint: string; p256dh: string; auth: string }>("SELECT endpoint, p256dh, auth FROM ctl_push").toArray();
    for (const sub of subs) {
      channels.push({ name: `push:${sub.endpoint.slice(-12)}`, send: async () => {
        const req = await buildPushRequest({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, msg, await this.vapid(), this.cenv.VAPID_SUBJECT || "https://github.com/vhmns14/overtime", { topic: c.trigger, urgency: c.trigger === "finished" ? "normal" : "high" });
        const res = await fetch(req.url, req.init);
        if (res.status === 404 || res.status === 410) sql.exec("DELETE FROM ctl_push WHERE endpoint = ?", sub.endpoint); // subscription gone
        return res.status;
      } });
    }
    for (const ch of channels) {
      if (opts.channel && !ch.name.startsWith(opts.channel)) continue;
      const dec = opts.force ? { send: true as const } : shouldSend(c, s, log, ch.name, t);
      if (!dec.send) { out.push({ channel: ch.name, ok: false, reason: dec.reason }); continue; }
      try {
        const status = await ch.send();
        const okk = status >= 200 && status < 300;
        record(ch.name, okk ? "sent" : `http ${status}`);
        out.push({ channel: ch.name, ok: okk, status });
        log.push({ key: c.key, channel: ch.name, at: t });
      } catch (e) {
        record(ch.name, "error");
        out.push({ channel: ch.name, ok: false, reason: (e as Error).name || "error" });
      }
    }
    if (!channels.length) out.push({ channel: "none", ok: false, reason: "no channel configured" });
    return out;
  }

  // ---------- stuck detection (server side, for notifications) ----------
  private stuckCandidates(t: number): { id: string; last_ts: number }[] {
    const notified = this.kv<Record<string, number>>("stuck_notified", {});
    return this.ctx.storage.sql.exec<{ id: string; last_ts: number }>("SELECT id, last_ts FROM sessions WHERE status = 'working' AND last_ts > ?", t - 24 * 3_600_000).toArray()
      .filter((r) => notified[r.id] !== r.last_ts);
  }

  private stuckDue(t = now()): number | null {
    const s = this.notifySettings();
    if (!s.enabled || !s.triggers.stuck) return null;
    const rows = this.stuckCandidates(t);
    if (!rows.length) return null;
    return Math.max(t + 1000, Math.min(...rows.map((r) => r.last_ts)) + s.stuckMinutes * 60_000);
  }

  private ttlDue(): number {
    const days = Math.max(1, Number(this.env.EXT_TTL_DAYS ?? 30) || 30);
    const last = Number(this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last'").toArray()[0]?.v ?? now());
    return last + days * 86_400_000;
  }

  async scheduleAlarm() {
    const due = this.stuckDue();
    const ttl = this.ttlDue();
    await this.ctx.storage.setAlarm(due ? Math.min(due, ttl) : ttl);
  }

  protected override async touchAlarm(force = false) {
    await super.touchAlarm(force);
    if (this.stuckDue() != null) await this.scheduleAlarm();
  }

  async checkStuck(t = now()) {
    const s = this.notifySettings();
    if (!s.enabled || !s.triggers.stuck) return;
    const ms = s.stuckMinutes * 60_000;
    const notified = this.kv<Record<string, number>>("stuck_notified", {});
    for (const r of this.stuckCandidates(t).filter((x) => x.last_ts <= t - ms)) {
      notified[r.id] = r.last_ts; // once per quiet stretch, whatever the delivery result
      const pending = this.ctx.storage.sql.exec("SELECT 1 FROM ctl_approvals WHERE session = ? AND status = 'pending'", r.id).toArray().length;
      if (pending) continue; // the approval notification covers it
      const mins = Math.round((t - r.last_ts) / 60_000);
      await this.deliver({ trigger: "stuck", key: `stuck:${r.id}:${r.last_ts}`, session: r.id, title: "Hermes looks stuck", body: `No activity for ${mins} min in a working session.` });
    }
    const keep = Object.entries(notified).sort((a, b) => b[1] - a[1]).slice(0, 50);
    this.setKv("stuck_notified", Object.fromEntries(keep));
  }

  override async alarm() {
    const t = now();
    await this.checkStuck(t);
    if (t >= this.ttlDue()) return super.alarm();
    await this.scheduleAlarm();
  }
}
