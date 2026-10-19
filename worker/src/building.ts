// Many Hermes, one building. A building is a small SQLite Durable Object that indexes office Durable
// Objects (one per Hermes install) as floors. It never copies events: each office keeps its own
// events, tokens and stream. The building only stores which office is on which floor, the office's
// read-only view token (so a building viewer can watch every floor), and its own two tokens:
//
//   admin (ot_bld_…)    add / remove floors
//   view  (ot_bview_…)  read-only: the building and every floor in it
//
// Adding an existing office needs that office's ingest token (you can only move in what you own);
// the building checks it with the office's own share() and keeps only the view token it returns.

import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex, safeEqual, bearer } from "../../src/ext/auth";
import { handleExt, EXT_CORS, type ExtEnv } from "./ext";
import { json } from "./lib";

export interface BuildingEnv extends ExtEnv {
  EXT_BUILDINGS: DurableObjectNamespace;
}

export const BUILDING_ID = /^bd-[a-z0-9]{8,24}$/;
export const MAX_FLOORS = 12;
const ok = (data: unknown, status = 200, extra: Record<string, string> = {}) => json(data, status, { ...EXT_CORS, ...extra });

interface BuildingConfig { id: string; name: string; createdAt: number; adminHash: string; viewHash: string; viewToken: string }
export interface FloorRow { floor: number; office: string; name: string; view: string; added: number }
export interface FloorView {
  floor: number;
  office: string;
  name: string;
  viewToken: string;
  /** from the office itself; null when it is gone (expired) */
  stats: { lastActivity: number; events: number; working: number; sessions: number; latest: { id: string; status: string; model?: string } | null } | null;
}

type BuildingWho = "admin" | "view" | null;

interface OfficeMetaRPC { meta(token: string): Promise<{ status: number; body: unknown }>; share(token: string): Promise<{ status: number; body: unknown }> }
interface BuildingRPC {
  init(cfg: BuildingConfig): Promise<boolean>;
  who(token: string): Promise<BuildingWho>;
  info(token: string): Promise<{ status: number; body: unknown }>;
  addFloor(token: string, office: string, name: string, view: string): Promise<{ status: number; body: unknown }>;
  removeFloor(token: string, floor: number): Promise<{ status: number; body: unknown }>;
}

const bstub = (env: BuildingEnv, id: string) => env.EXT_BUILDINGS.get(env.EXT_BUILDINGS.idFromName(id)) as unknown as BuildingRPC;
const ostub = (env: ExtEnv, id: string) => env.EXT_OFFICES.get(env.EXT_OFFICES.idFromName(id)) as unknown as OfficeMetaRPC;

export function newBuildingId(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return "bd-" + Array.from(b, (x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("").slice(0, 12);
}

/** 24 random bytes, base64url, with the building's own prefixes */
export const buildingToken = (prefix: "ot_bld" | "ot_bview") => randomToken("ot_view").replace(/^ot_view_/, `${prefix}_`);

const createHits = new Map<string, number[]>();
function createAllowed(ip: string, now = Date.now()): boolean {
  const hits = (createHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 5) return false;
  hits.push(now);
  createHits.set(ip, hits);
  if (createHits.size > 5000) createHits.clear();
  return true;
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const t = await req.text();
  if (t.length > 8192) return null;
  try { const v = t ? JSON.parse(t) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** Office stats for a floor plate, read through the office's own meta() with its view token. */
export async function officeStats(env: ExtEnv, office: string, view: string, now = Date.now()): Promise<FloorView["stats"]> {
  try {
    const r = await ostub(env, office).meta(view);
    if (r.status !== 200) return null;
    const m = r.body as { lastActivity?: number; events?: number; sessions?: { id: string; status: string; model?: string; lastTs: number }[] };
    const sessions = m.sessions ?? [];
    const working = sessions.filter((s) => s.status === "working" && now - s.lastTs < 10 * 60_000).length;
    const latest = sessions[0] ? { id: sessions[0].id, status: sessions[0].status, ...(sessions[0].model ? { model: sessions[0].model } : {}) } : null;
    return { lastActivity: m.lastActivity ?? 0, events: m.events ?? 0, working, sessions: sessions.length, latest };
  } catch {
    return null;
  }
}

/** Routes /api/ext/buildings/*. Returns null when the path is not ours. */
export async function handleBuilding(req: Request, env: BuildingEnv, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/ext/buildings")) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: EXT_CORS });
  const origin = url.origin;

  if (path === "/api/ext/buildings" && req.method === "POST") {
    if (!createAllowed(req.headers.get("cf-connecting-ip") ?? "local")) return ok({ error: "too many buildings created, try again in a minute" }, 429, { "retry-after": "60" });
    const b = await body(req);
    if (!b) return ok({ error: "invalid JSON" }, 400);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "My Hermes building";
    const id = newBuildingId();
    const adminToken = buildingToken("ot_bld");
    const viewToken = buildingToken("ot_bview");
    const cfg: BuildingConfig = { id, name, createdAt: Date.now(), adminHash: await sha256Hex(adminToken), viewHash: await sha256Hex(viewToken), viewToken };
    if (!(await bstub(env, id).init(cfg))) return ok({ error: "id collision, try again" }, 409);
    return ok({ buildingId: id, name, adminToken, viewToken, urls: { building: `${origin}/api/ext/buildings/${id}`, view: `${origin}/building/${id}#v=${viewToken}` } }, 201);
  }

  const m = path.match(/^\/api\/ext\/buildings\/([^/]+)(?:\/(floors)(?:\/(\d{1,2})\/(remove))?)?$/);
  if (!m) return ok({ error: "not found" }, 404);
  const [, id, sub, n, act] = m;
  if (!BUILDING_ID.test(id)) return ok({ error: "unknown building" }, 404);
  const token = bearer(req) || url.searchParams.get("v") || "";
  const s = bstub(env, id);

  if (!sub && req.method === "GET") {
    const r = await s.info(token);
    if (r.status !== 200) return ok(r.body, r.status);
    const info = r.body as { floors: FloorRow[]; role: BuildingWho; [k: string]: unknown };
    const now = Date.now();
    const floors: FloorView[] = await Promise.all(info.floors.map(async (f) => ({ floor: f.floor, office: f.office, name: f.name, viewToken: f.view, stats: await officeStats(env, f.office, f.view, now) })));
    return ok({ ...info, floors, ...(info.role === "admin" ? { urls: { view: `${origin}/building/${id}#v=${info.viewToken}` } } : {}), viewToken: undefined });
  }

  if (sub === "floors" && !n && req.method === "POST") {
    if ((await s.who(token)) !== "admin") return ok({ error: "the building's admin token is required" }, 401);
    const b = await body(req);
    if (!b) return ok({ error: "invalid JSON" }, 400);
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "";
    if (b.create) {
      // a new office for another Hermes install, created exactly like /api/ext/runs and moved in
      const privacy = typeof b.privacy === "string" ? b.privacy : "metadata";
      const cr = await handleExt(new Request(`${origin}/api/ext/runs`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": req.headers.get("cf-connecting-ip") ?? "local" }, body: JSON.stringify({ agent: "hermes", privacy, name: name || undefined }) }), env, new URL(`${origin}/api/ext/runs`));
      const created = (await cr!.json()) as Record<string, unknown>;
      if (cr!.status !== 201) return ok(created, cr!.status);
      const add = await s.addFloor(token, String(created.runId), name || String(created.name ?? "Hermes"), String(created.viewToken));
      if (add.status !== 200) return ok(add.body, add.status);
      return ok({ ...(add.body as object), office: created }, 201);
    }
    const office = typeof b.office === "string" ? b.office : "";
    const ingest = typeof b.ingestToken === "string" ? b.ingestToken : "";
    if (!/^of-[a-z0-9]{8,24}$/.test(office) || !ingest) return ok({ error: "give {office, ingestToken} to move an existing office in, or {create: true, name} for a new one" }, 400);
    const sh = await ostub(env, office).share(ingest);
    if (sh.status !== 200) return ok({ error: "that office's ingest token is required to move it into a building" }, 403);
    const meta = await ostub(env, office).meta(String((sh.body as { viewToken: string }).viewToken));
    const officeName = name || String((meta.body as { name?: string })?.name ?? "Hermes");
    const add = await s.addFloor(token, office, officeName, String((sh.body as { viewToken: string }).viewToken));
    return ok(add.body, add.status === 200 ? 201 : add.status);
  }

  if (sub === "floors" && n && act === "remove" && req.method === "POST") {
    const r = await s.removeFloor(token, Number(n));
    return ok(r.body, r.status);
  }
  return ok({ error: "method not allowed" }, 405);
}

export class ExtBuilding extends DurableObject<BuildingEnv> {
  private cfg: BuildingConfig | null = null;

  constructor(ctx: DurableObjectState, env: BuildingEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS floors (floor INTEGER PRIMARY KEY, office TEXT NOT NULL UNIQUE, name TEXT NOT NULL, view TEXT NOT NULL, added INTEGER NOT NULL)");
      const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'cfg'").toArray()[0];
      this.cfg = row ? JSON.parse(row.v) : null;
    });
  }

  async init(cfg: BuildingConfig): Promise<boolean> {
    if (this.cfg) return false;
    this.cfg = cfg;
    this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('cfg', ?)", JSON.stringify(cfg));
    await this.touch();
    return true;
  }

  async who(token: string): Promise<BuildingWho> {
    if (!this.cfg || !token) return null;
    const h = await sha256Hex(token);
    if (safeEqual(h, this.cfg.adminHash)) return "admin";
    if (safeEqual(h, this.cfg.viewHash)) return "view";
    return null;
  }

  private floors(): FloorRow[] {
    return this.ctx.storage.sql.exec("SELECT floor, office, name, view, added FROM floors ORDER BY floor").toArray() as unknown as FloorRow[];
  }

  async info(token: string) {
    const role = await this.who(token);
    if (!role || !this.cfg) return { status: 401, body: { error: "a building admin or view token is required" } };
    await this.touch();
    return { status: 200, body: { id: this.cfg.id, name: this.cfg.name, createdAt: this.cfg.createdAt, role, floors: this.floors(), viewToken: role === "admin" ? this.cfg.viewToken : undefined, maxFloors: MAX_FLOORS } };
  }

  async addFloor(token: string, office: string, name: string, view: string) {
    if ((await this.who(token)) !== "admin") return { status: 401, body: { error: "the building's admin token is required" } };
    const sql = this.ctx.storage.sql;
    const existing = (sql.exec("SELECT floor, office, name, view, added FROM floors WHERE office = ?", office).toArray() as unknown as FloorRow[])[0];
    if (existing) return { status: 200, body: { floor: existing.floor, office, name: existing.name, already: true } };
    const rows = this.floors();
    if (rows.length >= MAX_FLOORS) return { status: 409, body: { error: `a building has at most ${MAX_FLOORS} floors` } };
    // the lowest free floor number, so floors stay 1..n after a removal
    let floor = 1;
    while (rows.some((r) => r.floor === floor)) floor++;
    sql.exec("INSERT INTO floors (floor, office, name, view, added) VALUES (?, ?, ?, ?, ?)", floor, office, name.slice(0, 60), view, Date.now());
    await this.touch();
    return { status: 200, body: { floor, office, name } };
  }

  async removeFloor(token: string, floor: number) {
    if ((await this.who(token)) !== "admin") return { status: 401, body: { error: "the building's admin token is required" } };
    const sql = this.ctx.storage.sql;
    const had = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM floors WHERE floor = ?", floor).one().n;
    if (!had) return { status: 404, body: { error: "no such floor" } };
    sql.exec("DELETE FROM floors WHERE floor = ?", floor);
    return { status: 200, body: { removed: floor, note: "the office itself keeps running; only its floor in this building is gone" } };
  }

  /** a building nobody opens for 90 days is deleted (its offices are not touched) */
  private touchedAt = 0;
  private async touch() {
    if (Date.now() - this.touchedAt < 3_600_000) return;
    this.touchedAt = Date.now();
    await this.ctx.storage.setAlarm(Date.now() + 90 * 86_400_000);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.cfg = null;
  }
}
