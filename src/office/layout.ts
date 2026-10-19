// Coordinates in background-image space (office.png is 1195×896).
import type { Role } from "../engine/types";

export const BG = { w: 1195, h: 896 };
export const ROOM = { x: 18, y: 40, w: 1165, h: 845 };

export interface Pt { x: number; y: number }

/**
 * The office camera for a W×H element: one uniform scale and offset (CSS px = bg px × s + o) for the
 * room, the props and the characters alike. Desktop sits a little right of centre so the bookshelf by
 * the right wall stays in view; a phone zooms into the desk cluster.
 */
export function fitView(W: number, H: number): { s: number; ox: number; oy: number } {
  let s = Math.min(W / ROOM.w, H / ROOM.h) * 1.13;
  let cx = ROOM.x + ROOM.w / 2 + 36, cy = ROOM.y + ROOM.h / 2;
  if (W < 680 || W / Math.max(1, H) < 0.9) {
    s = Math.max(s, Math.min(H / 500, W / 600));
    cx = 505; cy = 505;
  }
  let ox = W / 2 - cx * s, oy = H / 2 - cy * s;
  if (BG.w * s > W) ox = Math.max(W - BG.w * s, Math.min(0, ox));
  if (BG.h * s > H) oy = Math.max(H - BG.h * s, Math.min(0, oy));
  return { s, ox, oy };
}

export interface Seat {
  /** where the character stands before sitting (a step from the chair, so sitting down is not a jump) */
  approach: Pt;
  /** feet / sprite bottom-centre while seated: placed so the sit sprite's hips land on the chair's cushion */
  seat: Pt;
  /** "back" = seen from behind facing up-left (sitA/sitB), "front" = facing the viewer behind the desk */
  facing: "back" | "front";
  /** centre of the chair's seat cushion as painted in office.png (where the hips go) */
  chair: Pt;
  /**
   * back-facing chairs: the backrest outline in office.png. The backrest is nearer the viewer than the
   * person sitting in it, so it is painted again over the sitter (without it they hover in front of the chair).
   */
  chairBack?: Pt[];
  /**
   * front-facing seats: the desk's back edge in office.png (a line through `x,y` with `slope`, the room's
   * 2:1 isometric). The sitter is hidden below it, so the desk covers the legs.
   */
  deskEdge?: { x: number; y: number; slope: number };
  monitor: Pt;
}

/** y of a desk's back edge at x */
export const deskEdgeY = (e: { x: number; y: number; slope: number }, x: number) => e.y + e.slope * (x - e.x);

// the three front-row chairs are the same painted chair, so their backrests share one outline
const PM_BACK: Pt[] = [
  { x: 504, y: 511 }, { x: 511, y: 503 }, { x: 536, y: 494 }, { x: 542, y: 499 }, { x: 542, y: 531 },
  { x: 532, y: 538 }, { x: 528, y: 546 }, { x: 519, y: 546 }, { x: 504, y: 543 },
];
const backAt = (dx: number, dy: number) => PM_BACK.map((p) => ({ x: p.x + dx, y: p.y + dy }));

// Measured against office.png and the sit sprites in atlas.json (tests/office-seats.test.ts checks them).
export const SEATS: Record<Role, Seat> = {
  pm: { approach: { x: 474, y: 584 }, seat: { x: 503, y: 554 }, facing: "back", chair: { x: 502, y: 541 }, chairBack: PM_BACK, monitor: { x: 452, y: 452 } },
  research: { approach: { x: 446, y: 338 }, seat: { x: 482, y: 388 }, facing: "front", chair: { x: 486, y: 331 }, deskEdge: { x: 482, y: 345, slope: -0.5 }, monitor: { x: 566, y: 318 } },
  coder: { approach: { x: 474, y: 770 }, seat: { x: 503, y: 740 }, facing: "back", chair: { x: 502, y: 727 }, chairBack: backAt(0, 186), monitor: { x: 450, y: 646 } },
  reviewer: { approach: { x: 646, y: 686 }, seat: { x: 675, y: 656 }, facing: "back", chair: { x: 674, y: 643 }, chairBack: backAt(172, 102), monitor: { x: 622, y: 553 } },
  ops: { approach: { x: 246, y: 536 }, seat: { x: 212, y: 580 }, facing: "front", chair: { x: 211, y: 557 }, deskEdge: { x: 212, y: 564, slope: -0.5 }, monitor: { x: 282, y: 545 } },
};

export const SPOTS = {
  coffee: { x: 668, y: 348 },
  board: { x: 852, y: 392 },
  meetA: { x: 792, y: 578 },
  meetB: { x: 878, y: 578 },
  sofa: { x: 840, y: 700 },
};

export const NODES: Record<string, Pt> = {
  hub: { x: 600, y: 470 },
  front: { x: 452, y: 594 },
  left: { x: 322, y: 482 },
  back: { x: 418, y: 378 },
  coffee: SPOTS.coffee,
  east: { x: 722, y: 468 },
  board: SPOTS.board,
  m1: SPOTS.meetA,
  m2: SPOTS.meetB,
  aisle: { x: 602, y: 706 },
  south: { x: 760, y: 640 },
};

export const EDGES: [string, string][] = [
  ["hub", "front"], ["hub", "east"], ["hub", "aisle"], ["front", "left"], ["front", "aisle"], ["left", "back"], ["back", "hub"],
  ["east", "coffee"], ["hub", "coffee"], ["east", "board"], ["east", "m1"], ["m1", "m2"], ["board", "m2"], ["aisle", "south"], ["south", "m1"], ["south", "east"],
];

/** floor lamps and desk lamps: glow centres */
export const LAMPS: (Pt & { r: number; a: number })[] = [
  { x: 572, y: 128, r: 150, a: 0.16 },
  { x: 990, y: 356, r: 130, a: 0.14 },
  { x: 888, y: 614, r: 120, a: 0.15 },
  { x: 328, y: 512, r: 80, a: 0.14 },
  { x: 504, y: 606, r: 70, a: 0.13 },
  { x: 728, y: 716, r: 70, a: 0.13 },
];

/** the rainy window on the left wall: four corners (tl, tr, br, bl) */
export const WINDOW: [Pt, Pt, Pt, Pt] = [{ x: 122, y: 262 }, { x: 408, y: 110 }, { x: 408, y: 278 }, { x: 122, y: 398 }];
/** whiteboard surface corners (tl, tr, br, bl) on the right wall */
export const BOARD: [Pt, Pt, Pt, Pt] = [{ x: 796, y: 166 }, { x: 956, y: 248 }, { x: 950, y: 356 }, { x: 792, y: 276 }];

export function quad(q: [Pt, Pt, Pt, Pt], u: number, v: number): Pt {
  const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
  const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

export function findPath(from: Pt, to: Pt): Pt[] {
  const names = Object.keys(NODES);
  const near = (p: Pt) => names.reduce((best, n) => (dist(NODES[n], p) < dist(NODES[best], p) ? n : best), names[0]);
  const a = near(from), b = near(to);
  const d: Record<string, number> = {}, prev: Record<string, string | null> = {};
  for (const n of names) { d[n] = Infinity; prev[n] = null; }
  d[a] = 0;
  const q = new Set(names);
  while (q.size) {
    let u = "";
    for (const n of q) if (!u || d[n] < d[u]) u = n;
    q.delete(u);
    if (u === b) break;
    for (const [x, y] of EDGES) {
      const v = x === u ? y : y === u ? x : null;
      if (!v || !q.has(v)) continue;
      const alt = d[u] + dist(NODES[u], NODES[v]);
      if (alt < d[v]) { d[v] = alt; prev[v] = u; }
    }
  }
  const path: Pt[] = [];
  for (let n: string | null = b; n; n = prev[n]) path.unshift(NODES[n]);
  // skip the graph entirely for short hops
  if (dist(from, to) < 90) return [to];
  return [...path, to];
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
