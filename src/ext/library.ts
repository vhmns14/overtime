// Hermes' skills and memory as office furniture: every skill is a book on the bookshelf (its versions
// count up as Hermes improves it), and memory writes/recalls make the filing cabinet glow.
// Pure and framework-free: the live office, the demo and the tests all use it.
//
// Two sources describe the same change on newer Hermes builds: the skill_manage tool call
// (post_tool_call, which Hermes 0.19 has) and the authoritative on_skill_lifecycle hook (newer).
// When both arrive for one change they are merged, so a single improvement adds one version.

import type { ExtEvent } from "./schema";

export interface SkillBook {
  name: string;
  /** 1 on creation; +1 for every patch or edit Hermes makes */
  versions: number;
  /** times Hermes loaded (or, on 0.19, viewed) the skill */
  uses: number;
  createdAt: number;
  updatedAt: number;
  lastAction: string;
  removed: boolean;
  provenance?: string;
  /** stable spine colour index, from the name */
  spine: number;
}

export interface LibraryState {
  skills: Record<string, SkillBook>;
  /** shelf order: first seen first */
  order: string[];
  memory: { writes: number; recalls: number; lastWriteAt: number; lastRecallAt: number; lastTarget?: string };
  /** recent changes per skill and kind, to merge tool + lifecycle reports of one change */
  recent: Record<string, { at: number; source: string }>;
}

export type LibraryEffect =
  | { k: "book"; name: string; change: "added" | "improved" | "used" | "removed" | "restored"; versions: number }
  | { k: "cabinet"; op: "write" | "recall" };

/** How close a tool report and a lifecycle report of the same change must be to count as one. */
export const MERGE_WINDOW_MS = 20_000;
export const SPINE_COLORS = 15;

export function newLibrary(): LibraryState {
  return { skills: {}, order: [], memory: { writes: 0, recalls: 0, lastWriteAt: 0, lastRecallAt: 0 }, recent: {} };
}

export function spineFor(name: string, n = SPINE_COLORS): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return h % n;
}

/** Normalises the verbs Hermes uses (lifecycle actions and skill_manage actions) to five kinds. */
export function skillKind(action: string): "create" | "improve" | "use" | "remove" | "restore" | null {
  const a = action.toLowerCase();
  if (["created", "create", "installed", "install", "learned"].includes(a)) return "create";
  if (["patched", "patch", "edited", "edit", "updated", "improved", "write_file", "remove_file"].includes(a)) return "improve";
  if (["loaded", "used", "use", "viewed", "view", "reused"].includes(a)) return "use";
  if (["deleted", "delete", "removed", "archived", "archive", "stale"].includes(a)) return "remove";
  if (["restored", "restore", "unarchived"].includes(a)) return "restore";
  return null;
}

/** Applies one event. Returns what the office should show, or null when nothing changed. */
export function applyLibrary(lib: LibraryState, e: Pick<ExtEvent, "type" | "ts" | "data">): LibraryEffect | null {
  if (e.type === "memory.write") {
    lib.memory.writes++;
    lib.memory.lastWriteAt = e.ts;
    const t = (e.data as { target?: string }).target;
    if (t) lib.memory.lastTarget = t;
    return { k: "cabinet", op: "write" };
  }
  if (e.type === "memory.recall") {
    lib.memory.recalls++;
    lib.memory.lastRecallAt = e.ts;
    return { k: "cabinet", op: "recall" };
  }
  if (e.type !== "skill.update") return null;
  const d = e.data as { name: string; action: string; source?: string; use_count?: number; provenance?: string };
  const name = String(d.name ?? "").trim().slice(0, 128);
  const kind = skillKind(String(d.action ?? ""));
  if (!name || !kind) return null;
  const source = d.source ?? "tool";

  // merge a tool report and a lifecycle report of the same change (either order)
  const key = `${name}\u0000${kind}`;
  const prev = lib.recent[key];
  lib.recent[key] = { at: e.ts, source };
  if (Object.keys(lib.recent).length > 400) for (const k of Object.keys(lib.recent)) if (e.ts - lib.recent[k].at > MERGE_WINDOW_MS) delete lib.recent[k];
  const duplicate = !!prev && prev.source !== source && Math.abs(e.ts - prev.at) <= MERGE_WINDOW_MS;

  let b = lib.skills[name];
  if (duplicate) {
    // the lifecycle hook carries the authoritative use count; keep it, count nothing twice
    if (b && kind === "use" && typeof d.use_count === "number") b.uses = Math.max(b.uses, d.use_count);
    if (b && d.provenance) b.provenance = d.provenance;
    return null;
  }

  const fresh = !b;
  if (!b) {
    b = lib.skills[name] = { name, versions: 0, uses: 0, createdAt: e.ts, updatedAt: e.ts, lastAction: d.action, removed: false, spine: spineFor(name) };
    lib.order.push(name);
  }
  b.updatedAt = Math.max(b.updatedAt, e.ts);
  b.lastAction = d.action;
  if (d.provenance) b.provenance = d.provenance;
  switch (kind) {
    case "create":
      // a re-create after a delete is a new logical skill (Hermes resets its record too)
      if (b.removed || fresh) { b.versions = 1; b.uses = 0; b.createdAt = e.ts; }
      else b.versions = Math.max(1, b.versions);
      b.removed = false;
      return { k: "book", name, change: "added", versions: b.versions };
    case "improve":
      // first seen as an improvement: it existed before Overtime was watching
      b.versions = Math.max(1, b.versions) + 1;
      b.removed = false;
      return { k: "book", name, change: fresh ? "added" : "improved", versions: b.versions };
    case "use":
      b.uses = typeof d.use_count === "number" ? Math.max(b.uses + (source === "lifecycle" ? 0 : 1), d.use_count) : b.uses + 1;
      if (fresh) b.versions = 1;
      return fresh ? { k: "book", name, change: "added", versions: b.versions } : { k: "book", name, change: "used", versions: b.versions };
    case "remove":
      if (fresh) b.versions = 1;
      b.removed = true;
      return { k: "book", name, change: "removed", versions: b.versions };
    case "restore":
      if (fresh) b.versions = 1;
      b.removed = false;
      return { k: "book", name, change: "restored", versions: b.versions };
  }
}

/** Skills on the shelf (removed ones are taken off), in shelf order. */
export function shelf(lib: LibraryState): SkillBook[] {
  return lib.order.map((n) => lib.skills[n]).filter((b) => b && !b.removed);
}

export function bookLabel(b: SkillBook): string {
  return `${b.name} · ${b.versions} version${b.versions === 1 ? "" : "s"}${b.uses ? ` · used ${b.uses}×` : ""}`;
}
