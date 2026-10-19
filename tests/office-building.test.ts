// Many Hermes, one building: the building Durable Object indexing office Durable Objects (real
// SQLite through the test harness), its tokens and routes, and the cross-section model.
import { beforeEach, describe, expect, it } from "vitest";
import { handleExt, ExtOffice } from "../worker/src/ext";
import { handleBuilding, ExtBuilding, MAX_FLOORS, type BuildingEnv } from "../worker/src/building";
import { fakeNamespace } from "./helpers/fake-do";
import { floorAt, floorStatus, installLine, normaliseFloors, stackBuilding, type Floor } from "../src/building/model";

let env: BuildingEnv;
const ORIGIN = "https://overtime.test";
let ip = 0;

beforeEach(() => {
  const offices = fakeNamespace((ctx) => new ExtOffice(ctx as never, env));
  const buildings = fakeNamespace((ctx) => new ExtBuilding(ctx as never, env));
  env = { EXT_OFFICES: offices as never, EXT_BUILDINGS: buildings as never, EXT_TTL_DAYS: "30" };
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { "content-type": "application/json", "cf-connecting-ip": `10.1.0.${++ip}`, ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const url = new URL(ORIGIN + path);
  const res = path.startsWith("/api/ext/buildings") ? (await handleBuilding(new Request(url, init), env, url))! : (await handleExt(new Request(url, init), env, url))!;
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function building(name = "HQ") {
  const r = await call("POST", "/api/ext/buildings", { name });
  expect(r.status).toBe(201);
  return r.json as { buildingId: string; adminToken: string; viewToken: string; urls: Record<string, string> };
}

async function office() {
  const r = await call("POST", "/api/ext/runs", { agent: "hermes", name: "Laptop" });
  return r.json as { runId: string; ingestToken: string; viewToken: string };
}

describe("building Durable Object", () => {
  it("creates a building with an admin token and a read-only view token and link", async () => {
    const b = await building("Kode Kecil HQ");
    expect(b.buildingId).toMatch(/^bd-[a-z0-9]{12}$/);
    expect(b.adminToken).toMatch(/^ot_bld_/);
    expect(b.viewToken).toMatch(/^ot_bview_/);
    expect(b.urls.view).toBe(`${ORIGIN}/building/${b.buildingId}#v=${b.viewToken}`);
    const info = await call("GET", `/api/ext/buildings/${b.buildingId}`, undefined, bearer(b.viewToken));
    expect(info.json).toMatchObject({ name: "Kode Kecil HQ", role: "view", floors: [] });
    expect(info.json.viewToken).toBeUndefined();
    expect((await call("GET", `/api/ext/buildings/${b.buildingId}`, undefined, bearer("ot_bview_nope"))).status).toBe(401);
  });

  it("moves an existing office in only with that office's ingest token, and lists its live stats", async () => {
    const b = await building();
    const o = await office();
    expect((await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: o.runId, ingestToken: o.viewToken }, bearer(b.adminToken))).status).toBe(403);
    expect((await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: o.runId, ingestToken: o.ingestToken }, bearer(b.viewToken))).status).toBe(401);
    const add = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: o.runId, ingestToken: o.ingestToken }, bearer(b.adminToken));
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({ floor: 1, office: o.runId, name: "Laptop" });
    // Hermes works on that office
    await call("POST", `/api/ext/runs/${o.runId}/events`, [{ type: "session.start", session: "s1", data: { model: "m" } }, { type: "tool.start", session: "s1", data: { name: "web_search" } }], bearer(o.ingestToken));
    const info = await call("GET", `/api/ext/buildings/${b.buildingId}?v=${b.viewToken}`);
    expect(info.json.floors).toHaveLength(1);
    expect(info.json.floors[0]).toMatchObject({ floor: 1, office: o.runId, viewToken: o.viewToken, stats: { events: 2, working: 1, sessions: 1, latest: { id: "s1", status: "working", model: "m" } } });
    // the view token handed out reads that office, read-only
    expect((await call("GET", `/api/ext/runs/${o.runId}/events?after=0`, undefined, bearer(info.json.floors[0].viewToken))).status).toBe(200);
    expect((await call("POST", `/api/ext/runs/${o.runId}/events`, { type: "session.start", data: {} }, bearer(info.json.floors[0].viewToken))).status).toBe(401);
  });

  it("creates a fresh office per Hermes install as the next floor, each with its own tokens", async () => {
    const b = await building();
    const a = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: "VPS · cron", privacy: "args" }, bearer(b.adminToken));
    const c = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: "Telegram bot" }, bearer(b.adminToken));
    expect(a.status).toBe(201);
    expect(a.json.floor).toBe(1);
    expect(c.json.floor).toBe(2);
    expect(a.json.office.ingestToken).not.toBe(c.json.office.ingestToken);
    expect(a.json.office.privacy).toBe("args");
    // each office only accepts its own ingest token
    expect((await call("POST", `/api/ext/runs/${a.json.office.runId}/events`, { type: "session.start", data: {} }, bearer(c.json.office.ingestToken))).status).toBe(401);
    expect((await call("POST", `/api/ext/runs/${a.json.office.runId}/events`, { type: "session.start", data: {} }, bearer(a.json.office.ingestToken))).status).toBe(200);
    const info = await call("GET", `/api/ext/buildings/${b.buildingId}`, undefined, bearer(b.adminToken));
    expect(info.json.role).toBe("admin");
    expect(info.json.urls.view).toBe(`${ORIGIN}/building/${b.buildingId}#v=${b.viewToken}`);
    expect(info.json.floors.map((f: Floor) => f.name)).toEqual(["VPS · cron", "Telegram bot"]);
  });

  it("is idempotent per office, removes floors without touching the office, reuses the gap, caps the height", async () => {
    const b = await building();
    const o = await office();
    await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: o.runId, ingestToken: o.ingestToken }, bearer(b.adminToken));
    const again = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: o.runId, ingestToken: o.ingestToken }, bearer(b.adminToken));
    expect(again.json).toMatchObject({ floor: 1, already: true });
    await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: "two" }, bearer(b.adminToken));
    expect((await call("POST", `/api/ext/buildings/${b.buildingId}/floors/1/remove`, undefined, bearer(b.viewToken))).status).toBe(401);
    expect((await call("POST", `/api/ext/buildings/${b.buildingId}/floors/1/remove`, undefined, bearer(b.adminToken))).status).toBe(200);
    expect((await call("GET", `/api/ext/runs/${o.runId}`, undefined, bearer(o.viewToken))).status).toBe(200); // the office lives on
    const three = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: "three" }, bearer(b.adminToken));
    expect(three.json.floor).toBe(1);
    for (let i = 0; i < MAX_FLOORS - 2; i++) await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: `f${i}` }, bearer(b.adminToken));
    const over = await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { create: true, name: "too high" }, bearer(b.adminToken));
    expect(over.status).toBe(409);
  });

  it("rejects malformed ids and requests", async () => {
    expect((await call("GET", "/api/ext/buildings/nope")).status).toBe(404);
    const b = await building();
    expect((await call("POST", `/api/ext/buildings/${b.buildingId}/floors`, { office: "of-x" }, bearer(b.adminToken))).status).toBe(400);
    expect((await call("PUT", `/api/ext/buildings/${b.buildingId}`, {}, bearer(b.adminToken))).status).toBe(405);
  });
});

describe("building cross-section model", () => {
  const FR = { roof: 139, roofRoomTop: 74, floors: [72, 72, 72], slab: 7, lobby: 81 };

  it("stacks roof (with the top floor), middle floors and the lobby; rooms are numbered top-down n…1", () => {
    const s = stackBuilding(4, FR);
    expect(s.parts.map((p) => p.frame)).toEqual(["b_roof", "b_floor0", "b_floor1", "b_floor2", "b_lobby"]);
    expect(s.rooms.map((r) => r.floor)).toEqual([4, 3, 2, 1]);
    expect(s.height).toBe(139 + 3 * 72 + 81);
    expect(s.rooms[1]).toEqual({ floor: 3, y: 139 + 7, h: 65 });
    // more floors than art: the middle-floor art repeats
    expect(stackBuilding(6, FR).parts.map((p) => p.frame).slice(1, -1)).toEqual(["b_floor0", "b_floor1", "b_floor2", "b_floor0", "b_floor1"]);
    // an empty building still has one (vacant) floor
    expect(stackBuilding(0, FR).rooms).toEqual([{ floor: 1, y: 74, h: 65 }]);
  });

  it("lights each floor by what its Hermes is doing", () => {
    const now = 1_792_000_000_000;
    const f = (stats: Floor["stats"]): Floor => ({ floor: 1, office: "of-x", name: "x", viewToken: "v", stats });
    const st = (lastAgo: number, working = 0, events = 5) => ({ lastActivity: now - lastAgo, events, working, sessions: 1, latest: null });
    expect(floorStatus(f(st(5_000, 1)), now)).toBe("lit");
    expect(floorStatus(f(st(30_000)), now)).toBe("recent");
    expect(floorStatus(f(st(5 * 60_000)), now)).toBe("quiet");
    expect(floorStatus(f(st(60 * 60_000)), now)).toBe("asleep");
    expect(floorStatus(f(st(60 * 60_000, 1)), now)).toBe("asleep"); // "working" but silent for an hour
    expect(floorStatus(f(st(0, 0, 0)), now)).toBe("quiet");
    expect(floorStatus(f(null), now)).toBe("gone");
    expect(floorStatus(null, now)).toBe("vacant");
  });

  it("normalises the floor list and maps rooms onto floors (gaps close up)", () => {
    const list = normaliseFloors([{ floor: 3, office: "of-c" }, { floor: 1, office: "of-a" }, { floor: 1, office: "of-dup" }, null, { floor: "x" }]);
    expect(list.map((f) => f.office)).toEqual(["of-a", "of-c"]);
    expect(floorAt(list, 2)?.office).toBe("of-c");
    expect(floorAt(list, 3)).toBeNull();
  });

  it("builds the one-line installer for a floor", () => {
    expect(installLine("https://ot.example", "of-abc12345", "ot_ing_x")).toBe("curl -fsSL https://ot.example/hermes-overtime/install.sh | sh -s -- --url https://ot.example/api/ext/runs/of-abc12345/hermes --token ot_ing_x --privacy metadata");
  });
});
