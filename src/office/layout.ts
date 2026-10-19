// Coordinates in background-image space (office.png is 1195×896).
import type { Role } from "../engine/types";

export const BG = { w: 1195, h: 896 };
export const ROOM = { x: 18, y: 40, w: 1165, h: 845 };

export interface Pt { x: number; y: number }

export interface Seat {
  /** where the character stands before sitting */
  approach: Pt;
  /** feet / sprite bottom-centre while seated */
  seat: Pt;
  /** "back" = seen from behind facing up-left (sitA/sitB), "front" = facing the viewer behind the desk */
  facing: "back" | "front";
  /** front-facing sitters are hidden below this y by the desk */
  clipY?: number;
  monitor: Pt;
}

export const SEATS: Record<Role, Seat> = {
  pm: { approach: { x: 560, y: 582 }, seat: { x: 520, y: 566 }, facing: "back", monitor: { x: 452, y: 452 } },
  research: { approach: { x: 432, y: 352 }, seat: { x: 482, y: 374 }, facing: "front", clipY: 346, monitor: { x: 566, y: 318 } },
  coder: { approach: { x: 566, y: 744 }, seat: { x: 517, y: 742 }, facing: "back", monitor: { x: 450, y: 646 } },
  reviewer: { approach: { x: 740, y: 662 }, seat: { x: 688, y: 662 }, facing: "back", monitor: { x: 622, y: 553 } },
  ops: { approach: { x: 262, y: 506 }, seat: { x: 212, y: 566 }, facing: "front", clipY: 552, monitor: { x: 282, y: 545 } },
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
