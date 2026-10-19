// Seated agents must sit IN their chairs, not hover beside them (they did: the seat anchors were the
// chair's caster base, so the hips floated off the cushion, the backrest that is nearer the viewer was
// painted under the sitter, and the front desks clipped at a flat line above the desk's sloped edge).
// These checks read the real pixels of office.png and the sit sprites in atlas.png.
import { describe, expect, it } from "vitest";
import { BG, SEATS, deskEdgeY, fitView, type Pt, type Seat } from "../src/office/layout";
import atlas from "../src/office/atlas.json";
import props from "../src/office/props-atlas.json";
import { ROLES } from "../src/engine/types";
import { readPng, rgba } from "./helpers/png";

const room = readPng("src/assets/office.png");
const sheet = readPng("src/assets/atlas.png");
const FR = (atlas as { frames: Record<string, { x: number; y: number; w: number; h: number }> }).frames;

/** the painted office chairs: dark, nearly grey (the floor and desks are warm wood) */
const chairLike = (x: number, y: number) => { const [r, g, b] = rgba(room, x, y); return Math.max(r, g, b) < 100 && r - b <= 30; };
const chairShare = (c: Pt, rad = 2) => { let n = 0, k = 0; for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { n++; if (chairLike(c.x + dx, c.y + dy)) k++; } return k / n; };
const sitFrames = (role: string, seat: Seat) => seat.facing === "front" ? [`${role}_fsitA`, `${role}_fsitB`] : [`${role}_sitA`, `${role}_sitB`];
/** is the sit sprite, drawn bottom-centre at the seat anchor (as scene.ts draws it), opaque at bg point p */
function spriteAt(name: string, seat: Seat, p: Pt) {
  const f = FR[name];
  const lx = Math.floor(p.x - Math.round(seat.seat.x - f.w / 2)), ly = Math.floor(p.y - Math.round(seat.seat.y - f.h));
  if (lx < 0 || ly < 0 || lx >= f.w || ly >= f.h) return false;
  return rgba(sheet, f.x + lx, f.y + ly)[3] > 0;
}
function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe("office seats line up with the chairs painted in office.png", () => {
  for (const role of ROLES) {
    const seat = SEATS[role];
    it(`${role}: the chair point is on a painted chair cushion`, () => {
      expect(chairShare(seat.chair)).toBeGreaterThanOrEqual(0.6);
    });

    it(`${role}: the sit sprite's hips land on the cushion (not hovering beside or above it)`, () => {
      for (const name of sitFrames(role, seat)) {
        expect(FR[name], name).toBeTruthy();
        // the character covers the cushion's centre…
        expect(spriteAt(name, seat, seat.chair), `${name} over the cushion`).toBe(true);
        // …with its hips, not its head: the cushion is in the lower part of the sprite
        const f = FR[name];
        const fromFeet = seat.seat.y - seat.chair.y;
        expect(fromFeet, `${name}: cushion height above the feet`).toBeGreaterThan(5);
        expect(fromFeet / f.h, `${name}: cushion in the lower half`).toBeLessThan(seat.facing === "front" ? 0.6 : 0.3);
        if (seat.facing === "back") {
          // and centred on it: the lower body (hips, thighs, legs) is over the cushion, not off to the side
          let sx = 0, n = 0;
          for (let ly = Math.floor(f.h * 0.55); ly < f.h; ly++) for (let lx = 0; lx < f.w; lx++) if (rgba(sheet, f.x + lx, f.y + ly)[3] > 0) { sx += lx; n++; }
          const cx = Math.round(seat.seat.x - f.w / 2) + sx / n;
          expect(Math.abs(cx - seat.chair.x), `${name}: lower body ${cx.toFixed(1)} vs cushion ${seat.chair.x}`).toBeLessThanOrEqual(5);
        }
      }
    });

    if (seat.facing === "back") {
      it(`${role}: the backrest (nearer the viewer) is painted over the sitter's back, the head shows above it`, () => {
        const poly = seat.chairBack!;
        expect(poly, "back-facing seats need their backrest outline").toBeTruthy();
        const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
        let inside = 0, chair = 0;
        for (let y = Math.min(...ys); y <= Math.max(...ys); y++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
          if (!inPoly({ x: x + 0.5, y: y + 0.5 }, poly)) continue;
          inside++;
          if (chairLike(x, y)) chair++;
        }
        // the outline really is the painted backrest
        expect(chair / inside).toBeGreaterThan(0.8);
        for (const name of sitFrames(role, seat)) {
          const f = FR[name];
          const x0 = Math.round(seat.seat.x - f.w / 2), y0 = Math.round(seat.seat.y - f.h);
          let body = 0, covered = 0, top = Infinity;
          for (let ly = 0; ly < f.h; ly++) for (let lx = 0; lx < f.w; lx++) {
            if (rgba(sheet, f.x + lx, f.y + ly)[3] === 0) continue;
            body++;
            top = Math.min(top, y0 + ly);
            if (inPoly({ x: x0 + lx + 0.5, y: y0 + ly + 0.5 }, poly)) covered++;
          }
          // the backrest hides part of the back (they sit in the chair, not in front of it)…
          expect(covered / body, `${name} behind its backrest`).toBeGreaterThan(0.15);
          // …but not the whole person: the head is above the backrest
          expect(top, `${name} head above the backrest`).toBeLessThan(Math.min(...ys) - 4);
        }
      });
    } else {
      it(`${role}: the desk's sloped back edge hides the legs, the cushion shows above it`, () => {
        const e = seat.deskEdge!;
        expect(e, "front-facing seats need their desk edge").toBeTruthy();
        // the cushion is above the desk edge, the desk (not the chair) is just below it
        expect(seat.chair.y).toBeLessThan(deskEdgeY(e, seat.chair.x));
        // along the edge: chair cushion just above it, desk top (wood, paper, keyboard) just below it
        const along = (off: number) => { let k = 0; for (let x = e.x - 15; x <= e.x + 15; x++) if (chairLike(x, Math.round(deskEdgeY(e, x) + off))) k++; return k / 31; };
        expect(along(-4)).toBeGreaterThan(0.75);
        expect(along(5)).toBeLessThan(0.45);
        // the feet are well under the desk, so no shoes peek out below it
        expect(seat.seat.y - deskEdgeY(e, seat.seat.x)).toBeGreaterThanOrEqual(12);
      });
    }

    it(`${role}: sitting down is a step from the chair, not a jump across the room`, () => {
      expect(Math.hypot(seat.approach.x - seat.seat.x, seat.approach.y - seat.seat.y)).toBeLessThan(70);
    });
  }

  it("no prop drawn over the characters overlaps a seated agent", () => {
    const p = (props as unknown as { place: { plantOccluder: { x: number; y: number; w: number; h: number } } }).place.plantOccluder;
    for (const role of ROLES) {
      const seat = SEATS[role];
      for (const name of sitFrames(role, seat)) {
        const f = FR[name];
        const x0 = seat.seat.x - f.w / 2, y0 = seat.seat.y - f.h;
        const overlap = x0 < p.x + p.w && x0 + f.w > p.x && y0 < p.y + p.h && y0 + f.h > p.y;
        expect(overlap, `${name} under the plant`).toBe(false);
      }
    }
  });
});

describe("office camera", () => {
  const onScreen = (v: { s: number; ox: number; oy: number }, p: Pt) => ({ x: p.x * v.s + v.ox, y: p.y * v.s + v.oy });

  it("moves the room and the seated agents together (one scale, one offset) at every size", () => {
    for (const [W, H] of [[1066, 900], [1440, 900], [800, 700], [390, 560], [360, 520]]) {
      const v = fitView(W, H);
      // the room image is drawn at (0,0) under the same transform
      const tl = onScreen(v, { x: 0, y: 0 }), br = onScreen(v, { x: BG.w, y: BG.h });
      for (const role of ROLES) {
        const { chair, seat } = SEATS[role];
        const c = onScreen(v, chair), s = onScreen(v, seat);
        // the chair's position inside the drawn room equals the bg-space chair: no extra offset for actors
        expect((c.x - tl.x) / (br.x - tl.x)).toBeCloseTo(chair.x / BG.w, 9);
        expect((c.y - tl.y) / (br.y - tl.y)).toBeCloseTo(chair.y / BG.h, 9);
        expect(s.y - c.y).toBeCloseTo((seat.y - chair.y) * v.s, 9);
      }
    }
  });

  it("keeps every desk in view on desktop and the desk cluster on a phone", () => {
    for (const [W, H, roles] of [[1066, 900, ROLES], [1440, 900, ROLES], [390, 560, ["pm", "research", "coder", "reviewer"]]] as const) {
      const v = fitView(W, H);
      for (const role of roles) {
        const c = onScreen(v, SEATS[role].chair);
        expect(c.x, `${role} x at ${W}`).toBeGreaterThan(0);
        expect(c.x).toBeLessThan(W);
        expect(c.y).toBeGreaterThan(0);
        expect(c.y).toBeLessThan(H);
      }
    }
  });
});
