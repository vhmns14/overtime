// Many Hermes, one building: the pure parts. How the cross-section stacks (roof with the top floor,
// repeatable middle floors, the lobby), which floor is which, and how lit each floor is.

export interface FloorStats {
  lastActivity: number;
  events: number;
  working: number;
  sessions: number;
  latest: { id: string; status: string; model?: string } | null;
}

export interface Floor {
  floor: number;
  office: string;
  name: string;
  viewToken: string;
  stats: FloorStats | null;
}

/** lit = Hermes is working right now · recent = ran in the last few minutes · quiet = lights low · asleep · gone = office expired */
export type FloorStatus = "lit" | "recent" | "quiet" | "asleep" | "vacant" | "gone";

export function floorStatus(f: Floor | null, now: number, dimAfterMs = 2 * 60_000, sleepAfterMs = 10 * 60_000): FloorStatus {
  if (!f) return "vacant";
  const s = f.stats;
  if (!s) return "gone";
  if (!s.events) return "quiet";
  if (s.working > 0 && now - s.lastActivity < sleepAfterMs) return "lit";
  const quiet = now - s.lastActivity;
  if (quiet < dimAfterMs) return "recent";
  if (quiet < sleepAfterMs) return "quiet";
  return "asleep";
}

export const STATUS_LABEL: Record<FloorStatus, string> = {
  lit: "working", recent: "just ran", quiet: "quiet", asleep: "asleep", vacant: "vacant", gone: "office expired",
};

export interface Part { frame: string; y: number; h: number }
export interface Room { floor: number; y: number; h: number }

/** frame heights of the sliced building art (roof includes the top floor's room) */
export interface StackFrames { roof: number; roofRoomTop: number; floors: number[]; slab: number; lobby: number }

/**
 * Stacks the cross-section for `n` floors, top to bottom: the roof (with floor n), floors n-1 … 1 cycling
 * through the middle-floor art, then the lobby. At least one floor is drawn (an empty building shows a
 * vacant top floor). Rooms are the clickable areas, in building pixels.
 */
export function stackBuilding(n: number, fr: StackFrames): { parts: Part[]; rooms: Room[]; height: number } {
  const floors = Math.max(1, n);
  const parts: Part[] = [{ frame: "b_roof", y: 0, h: fr.roof }];
  const rooms: Room[] = [{ floor: floors, y: fr.roofRoomTop, h: fr.roof - fr.roofRoomTop }];
  let y = fr.roof;
  for (let k = floors - 1; k >= 1; k--) {
    const i = (floors - 1 - k) % fr.floors.length;
    const h = fr.floors[i];
    parts.push({ frame: `b_floor${i}`, y, h });
    rooms.push({ floor: k, y: y + fr.slab, h: h - fr.slab });
    y += h;
  }
  parts.push({ frame: "b_lobby", y, h: fr.lobby });
  return { parts, rooms, height: y + fr.lobby };
}

/** the floor list from the API, sorted bottom-up, with each floor number unique */
export function normaliseFloors(list: unknown): Floor[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<number>();
  return list
    .filter((f): f is Floor => !!f && typeof f === "object" && Number.isInteger((f as Floor).floor) && typeof (f as Floor).office === "string")
    .filter((f) => (seen.has(f.floor) ? false : (seen.add(f.floor), true)))
    .sort((a, b) => a.floor - b.floor);
}

/** Display floors: the building's floor numbers mapped onto stacked rooms 1..n (gaps close up). */
export function floorAt(floors: Floor[], room: number): Floor | null {
  return floors[room - 1] ?? null;
}

export function ago(ts: number, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The one-line installer a Hermes machine runs to join this office (docs/SELF_HOST.md). */
export function installLine(origin: string, office: string, ingestToken: string, privacy = "metadata"): string {
  return `curl -fsSL ${origin}/hermes-overtime/install.sh | sh -s -- --url ${origin}/api/ext/runs/${office}/hermes --token ${ingestToken} --privacy ${privacy}`;
}

/** An offline sample building (the recorded demo on floor 1), for preview.html and visitors without a Hermes yet. */
export function demoFloors(now: number): Floor[] {
  const st = (agoMs: number, working: number, sessions: number, model: string, status: string): FloorStats => ({ lastActivity: now - agoMs, events: 40 + sessions * 25, working, sessions, latest: { id: `demo-${sessions}`, status, model } });
  return [
    { floor: 1, office: "demo", name: "Demo · recorded Hermes session", viewToken: "", stats: st(20_000, 1, 1, "openai/gpt-4o-mini", "working") },
    { floor: 2, office: "demo-vps", name: "Sample · VPS gateway", viewToken: "", stats: st(4 * 60_000, 0, 6, "anthropic/claude-sonnet-4", "completed") },
    { floor: 3, office: "demo-cron", name: "Sample · nightly cron", viewToken: "", stats: st(3 * 3_600_000, 0, 14, "openai/gpt-4o-mini", "completed") },
  ];
}
