// The pixel office: a pre-rendered isometric room (generated art) with sprite characters walking a
// small nav graph, typing at desks, meeting at the round table, updating the whiteboard and
// fetching coffee. Lamp glow, monitor light and rain are drawn live on a 2D canvas.

import atlasJson from "./atlas.json";
import { BOARD, LAMPS, SEATS, SPOTS, WINDOW, deskEdgeY, dist, findPath, fitView, quad, type Pt, type Seat } from "./layout";
import { ROLES, ROLE_INFO, type Role, type Ticket } from "../engine/types";

type Frame = { x: number; y: number; w: number; h: number };
const FRAMES = (atlasJson as { frames: Record<string, Frame> }).frames;

type Mode = "sit" | "stand" | "walk" | "mug";
type Look = "front" | "back";

interface Actor {
  role: Role;
  x: number;
  y: number;
  path: Pt[];
  mode: Mode;
  look: Look;
  flip: boolean;
  working: boolean;
  busy: boolean; // in a scripted move (meeting / whiteboard / coffee)
  waiting: boolean;
  arrive?: (ok?: boolean) => void;
  bubble?: { text: string; until: number; kind: "talk" | "think" | "wait" };
  phase: number;
  /** office reactions: dozing at the desk, lying on the sofa, the wake-up stretch, a slump after a failure */
  pose?: "sleep" | "lie" | "stretch" | "slump";
  poseUntil?: number;
  el: HTMLElement;
  tag: HTMLElement;
  bub: HTMLElement;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface OfficeOptions {
  speed?: number;
  onSelect?: (role: Role) => void;
}

/** Extra drawing on top of the room (props, lighting, particles). Coordinates are office.png pixels. */
export interface OfficeLayer {
  /** after the room, before the light and the characters */
  back?(ctx: CanvasRenderingContext2D, t: number): void;
  /** after the characters */
  top?(ctx: CanvasRenderingContext2D, t: number): void;
  /** once per frame after drawing, for DOM overlays (use office.bgToScreen) */
  place?(t: number): void;
}

/** where a dozing character lies on the bench by the meeting table (feet → head along the seat) */
export const SOFA = { approach: { x: 770, y: 652 }, seat: { x: 812, y: 690 }, angle: -0.43, backTop: { x0: 788, y0: 706, slope: -0.46 } };

export class Office {
  private ctx: CanvasRenderingContext2D;
  private actors = {} as Record<Role, Actor>;
  private view = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
  private drops: { u: number; v: number; l: number; sp: number }[] = [];
  private tickets: Ticket[] = [];
  private prNote: string | null = null;
  private celebrateUntil: Partial<Record<Role, number>> = {};
  private stuck = new Set<Role>();
  private raf = 0;
  private last = 0;
  private flashUntil = 0;
  private nextFlash = 0;
  private nextAmbient = 0;
  private rand = rng(20261019);
  private ro: ResizeObserver;
  private layers: OfficeLayer[] = [];
  /** the lit room under each back-facing chair's backrest, copied before the characters are drawn */
  private chairPatches: Partial<Record<Role, { c: HTMLCanvasElement; x: number; y: number; ok: boolean }>> = {};
  /** 0 = lights on, 1 = lamps fully dimmed (idle office) */
  dim = 0;
  speed: number;

  constructor(private root: HTMLElement, private bg: HTMLImageElement, private atlas: HTMLImageElement, private opts: OfficeOptions = {}) {
    this.speed = opts.speed ?? 1;
    const canvas = document.createElement("canvas");
    canvas.className = "office-canvas";
    canvas.setAttribute("aria-label", "Pixel-art office where the agents work. Click an agent to see what they are doing.");
    canvas.setAttribute("role", "img");
    root.appendChild(canvas);
    const layer = document.createElement("div");
    layer.className = "office-layer";
    root.appendChild(layer);
    this.ctx = canvas.getContext("2d")!;
    for (const role of ROLES) {
      const s = SEATS[role];
      const el = document.createElement("button");
      el.className = "actor";
      el.type = "button";
      el.dataset.role = role;
      el.setAttribute("aria-label", `${ROLE_INFO[role].name}: open details`);
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = ROLE_INFO[role].name;
      const bub = document.createElement("span");
      bub.className = "bubble";
      bub.hidden = true;
      el.append(bub, tag);
      el.addEventListener("click", () => this.opts.onSelect?.(role));
      layer.appendChild(el);
      this.actors[role] = { role, x: s.seat.x, y: s.seat.y, path: [], mode: "sit", look: s.facing, flip: false, working: false, busy: false, waiting: false, phase: this.rand() * 10, el, tag, bub };
    }
    for (let i = 0; i < 90; i++) this.drops.push({ u: this.rand(), v: this.rand(), l: 0.05 + this.rand() * 0.07, sp: 0.35 + this.rand() * 0.35 });
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const p = this.toBg(e.clientX - r.left, e.clientY - r.top);
      const hit = this.hitTest(p);
      if (hit) this.opts.onSelect?.(hit);
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.resize();
    this.nextAmbient = performance.now() + 2500;
    this.nextFlash = performance.now() + 9000;
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - (this.last || t)) / 1000);
      this.last = t;
      this.update(dt, t);
      this.draw(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  // ---------- view ----------
  private resize() {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.ctx.canvas;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = W + "px";
    c.style.height = H + "px";
    // one scale + offset for the room and everyone in it (layout.ts fitView), so seats stay on their chairs
    const { s, ox, oy } = fitView(W, H);
    this.view = { s, ox, oy, w: W, h: H, dpr };
  }
  private toBg(x: number, y: number): Pt { return { x: (x - this.view.ox) / this.view.s, y: (y - this.view.oy) / this.view.s }; }
  private toScreen(p: Pt): Pt { return { x: p.x * this.view.s + this.view.ox, y: p.y * this.view.s + this.view.oy }; }

  private frameFor(a: Actor, t: number): { name: string; flip: boolean; desk?: Seat["deskEdge"] } {
    const r = a.role;
    const tick = Math.floor((t / 1000 + a.phase) * 6);
    if (a.mode === "walk") {
      const f = tick % 2 === 0;
      return a.look === "front" ? { name: `${r}_${f ? "walkA" : "walkB"}`, flip: a.flip } : { name: `${r}_${f ? "bwalkA" : "bwalkB"}`, flip: a.flip };
    }
    if (a.mode === "mug") return { name: `${r}_mug`, flip: a.flip };
    if (a.mode === "stand") return { name: `${r}_${a.look === "front" ? "idle" : "back"}`, flip: a.flip };
    const seat = SEATS[r];
    const typing = a.working && Math.floor((t / 1000 + a.phase) * 5) % 2 === 0;
    if (seat.facing === "front" && FRAMES[`${r}_fsitA`]) return { name: `${r}_${typing ? "fsitB" : "fsitA"}`, flip: false, desk: seat.deskEdge };
    return { name: `${r}_${typing ? "sitB" : "sitA"}`, flip: false };
  }

  private hitTest(p: Pt): Role | null {
    let best: Role | null = null;
    for (const a of Object.values(this.actors)) {
      const f = FRAMES[this.frameFor(a, 0).name];
      if (p.x > a.x - f.w / 2 - 6 && p.x < a.x + f.w / 2 + 6 && p.y > a.y - f.h - 6 && p.y < a.y + 4) {
        if (!best || a.y > this.actors[best].y) best = a.role;
      }
    }
    return best;
  }

  // ---------- movement ----------
  /** Walks to a point. Resolves true on arrival, false if a newer move superseded this one. */
  private go(role: Role, to: Pt, mode: "stand" | "mug" = "stand"): Promise<boolean> {
    const a = this.actors[role];
    a.arrive?.(false);
    return new Promise((resolve) => {
      const start = a.mode === "sit" ? SEATS[role].approach : { x: a.x, y: a.y };
      if (a.mode === "sit") { a.x = start.x; a.y = start.y; }
      a.path = findPath(start, to);
      a.mode = "walk";
      a.arrive = (ok = true) => {
        a.arrive = undefined;
        if (ok) a.mode = mode;
        resolve(ok);
      };
    });
  }

  private async sit(role: Role) {
    const a = this.actors[role];
    if (a.mode === "sit" && !a.path.length) return;
    if (!(await this.go(role, SEATS[role].approach))) return;
    a.mode = "sit";
    a.x = SEATS[role].seat.x;
    a.y = SEATS[role].seat.y;
  }

  private update(dt: number, t: number) {
    const sp = 95 / Math.max(0.15, this.speed); // px/s in bg space
    for (const a of Object.values(this.actors)) {
      if (a.mode !== "walk") continue;
      let left = sp * dt;
      while (left > 0 && a.path.length) {
        const n = a.path[0];
        const d = dist(a, n);
        const dx = n.x - a.x, dy = n.y - a.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) {
          a.look = dy > 0 ? "front" : "back";
          a.flip = a.look === "front" ? dx < 0 : dx > 0;
        }
        if (d <= left) { a.x = n.x; a.y = n.y; a.path.shift(); left -= d; }
        else { a.x += (dx / d) * left; a.y += (dy / d) * left; left = 0; }
      }
      if (!a.path.length) a.arrive?.();
    }
    // ambient life: idle agents fetch coffee now and then
    if (t > this.nextAmbient) {
      this.nextAmbient = t + (7000 + this.rand() * 7000);
      const idle = this.dim > 0.5 ? [] : ROLES.filter((r) => { const a = this.actors[r]; return !a.working && !a.busy && !a.waiting && a.mode === "sit" && !a.pose; });
      const coffeeTaken = ROLES.some((r) => this.actors[r].busy && this.actors[r].mode === "mug");
      if (idle.length && !coffeeTaken) this.coffee(idle[Math.floor(this.rand() * idle.length)]);
    }
    if (t > this.nextFlash) { this.flashUntil = t + 140; this.nextFlash = t + 18000 + this.rand() * 22000; }
  }

  private async coffee(role: Role) {
    const a = this.actors[role];
    a.busy = true;
    if (!(await this.go(role, SPOTS.coffee))) return;
    a.look = "back"; a.flip = true; a.mode = "stand";
    await this.wait(1200);
    if (!a.busy || a.mode !== "stand") return;
    a.mode = "mug"; a.look = "front"; a.flip = false;
    this.say(role, "☕", "think", 1800);
    await this.wait(2600);
    if (!a.busy || a.mode !== "mug") return;
    a.busy = false;
    if (!a.working) await this.sit(role);
  }

  private wait(ms: number) { return new Promise<void>((r) => setTimeout(r, ms * this.speed)); }

  // ---------- public API driven by run events ----------
  setWorking(role: Role, working: boolean) {
    const a = this.actors[role];
    if (working && (a.pose === "sleep" || a.pose === "lie")) void this.wake(role);
    a.waiting = false;
    if (a.bubble?.kind === "wait") a.bubble = undefined;
    a.working = working;
    if (working) { a.busy = false; void this.sit(role); }
  }

  setWaiting(role: Role, text = "Needs your OK") {
    const a = this.actors[role];
    a.waiting = true;
    a.working = false;
    a.bubble = { text, until: Infinity, kind: "wait" };
  }

  clearWaiting() {
    for (const a of Object.values(this.actors)) if (a.waiting) { a.waiting = false; if (a.bubble?.kind === "wait") a.bubble = undefined; }
  }

  say(role: Role, text: string, kind: "talk" | "think" = "think", ms = 2600) {
    const a = this.actors[role];
    if (a.bubble?.kind === "wait") return;
    a.bubble = { text, until: performance.now() + ms * Math.max(0.5, this.speed), kind };
  }

  async meeting(from: Role, to: Role, summary: string) {
    const A = this.actors[from], B = this.actors[to];
    A.busy = B.busy = true;
    A.working = B.working = false;
    await Promise.all([this.go(from, SPOTS.meetA), this.go(to, SPOTS.meetB)]);
    A.mode = "stand"; A.look = "front"; A.flip = false;
    B.mode = "stand"; B.look = "front"; B.flip = true;
    this.say(from, summary, "talk", 3200);
    await this.wait(3000);
    this.say(to, "On it!", "talk", 1300);
    await this.wait(900);
    A.busy = B.busy = false;
    void this.sit(from);
    void this.sit(to);
  }

  async whiteboard(tickets: Ticket[]) {
    const a = this.actors.pm;
    a.busy = true;
    a.working = false;
    if (!(await this.go("pm", SPOTS.board))) { a.busy = false; this.tickets = tickets; return; }
    a.mode = "stand"; a.look = "back"; a.flip = true;
    for (let i = 1; i <= tickets.length; i++) {
      this.tickets = tickets.slice(0, i);
      await this.wait(220);
    }
    this.say("pm", `${tickets.length} tickets on the board`, "talk", 1800);
    await this.wait(1200);
    a.busy = false;
  }

  setTickets(tickets: Ticket[]) { this.tickets = tickets; }

  /** Name tag over a character (an external agent's subagent borrows a desk); null restores the role name. */
  setTag(role: Role, text: string | null) {
    const a = this.actors[role];
    a.tag.textContent = text ?? ROLE_INFO[role].name;
    a.el.setAttribute("aria-label", `${text ?? ROLE_INFO[role].name}: open details`);
    a.el.classList.toggle("is-borrowed", !!text);
  }

  /** An orange sticky with the PR number on the whiteboard. */
  setPrNote(text: string | null) { this.prNote = text; }

  /** Ops walks to the whiteboard, pins the PR sticky and hops for joy. */
  async celebrate(role: Role, note: string, line: string) {
    const a = this.actors[role];
    a.busy = true;
    a.working = false;
    const arrived = await this.go(role, SPOTS.board);
    if (arrived) { a.mode = "stand"; a.look = "front"; a.flip = false; }
    this.prNote = note;
    this.celebrateUntil[role] = performance.now() + 2600 * Math.max(0.5, this.speed);
    for (const r of ROLES) if (r !== role) this.celebrateUntil[r] = performance.now() + 1400 * Math.max(0.5, this.speed);
    this.say(role, line, "talk", 3600);
    await this.wait(2600);
    a.busy = false;
    void this.sit(role);
  }

  /** A stuck agent (insights' stuck detection) scratches its head under a red "?"; false clears it. */
  setStuck(role: Role, on: boolean) {
    if (on) this.stuck.add(role);
    else this.stuck.delete(role);
    const a = this.actors[role];
    a.el.classList.toggle("is-stuck", on);
    let q = a.el.querySelector<HTMLElement>(".qmark");
    if (on && !q) {
      q = document.createElement("span");
      q.className = "qmark";
      q.textContent = "?";
      q.setAttribute("aria-hidden", "true");
      a.el.prepend(q);
    }
    if (!on) q?.remove();
  }


  // ---------- office reactions (src/office/ambience.ts drives these) ----------
  addLayer(l: OfficeLayer) { this.layers.push(l); }

  /** office.png pixel → CSS pixel inside the office element */
  bgToScreen(p: Pt): Pt { return this.toScreen(p); }
  get viewScale() { return this.view.s; }

  isPosed(role: Role) { return !!this.actors[role].pose; }

  /** where a character's head is (office.png pixels) and what it is doing, for particles like Zzz */
  actorInfo(role: Role): { head: Pt; pose?: string; mode: string } {
    const a = this.actors[role];
    if (a.pose === "lie") return { head: { x: SOFA.seat.x + 14, y: SOFA.seat.y - 18 }, pose: a.pose, mode: a.mode };
    const f = FRAMES[this.frameFor(a, 0).name];
    return { head: { x: a.x, y: a.y - (f?.h ?? 60) + 6 }, pose: a.pose, mode: a.mode };
  }

  /** Doze at the desk (or lie down on the bench when `sofa`). */
  async sleep(role: Role, sofa = false) {
    const a = this.actors[role];
    if (a.pose === "sleep" || a.pose === "lie") return;
    a.working = false;
    if (a.bubble?.kind !== "wait") a.bubble = undefined;
    if (sofa) {
      a.busy = true;
      if (!(await this.go(role, SOFA.approach))) return;
      a.mode = "stand";
      a.pose = "lie";
      a.poseUntil = Infinity;
      return;
    }
    if (a.mode !== "sit") await this.sit(role);
    a.pose = "sleep";
    a.poseUntil = Infinity;
  }

  /** Wake up: stretch where they are, then go back to the desk. */
  async wake(role: Role, stretch = true) {
    const a = this.actors[role];
    const was = a.pose;
    if (!was || was === "stretch") return;
    if (!stretch) { a.pose = undefined; if (was === "lie") { a.busy = false; void this.sit(role); } return; }
    if (was === "lie") { a.x = SOFA.approach.x; a.y = SOFA.approach.y; a.mode = "stand"; a.look = "front"; a.flip = false; }
    a.pose = "stretch";
    a.poseUntil = performance.now() + 1600 * Math.max(0.5, this.speed);
    this.say(role, ["*yawn*", "Huh? Back to it!", "*stretch*", "Morning!"][ROLES.indexOf(role) % 4], "talk", 1500);
    await this.wait(1600);
    if (a.pose === "stretch") a.pose = undefined;
    if (was === "lie") { a.busy = false; if (!a.waiting) await this.sit(role); }
  }

  /** Small celebration: everyone hops. */
  cheer(line = "Nice!") {
    const now = performance.now();
    for (const r of ROLES) if (!this.actors[r].pose) this.celebrateUntil[r] = now + (1000 + ROLES.indexOf(r) * 120) * Math.max(0.5, this.speed);
    this.say("pm", line, "talk", 1800);
  }

  /** A slump after a failed turn. */
  slump(line = "Oof.") {
    const until = performance.now() + 3200 * Math.max(0.5, this.speed);
    for (const r of ROLES) { const a = this.actors[r]; if (!a.pose && a.mode === "sit") { a.pose = "slump"; a.poseUntil = until; } }
    this.say("pm", line, "talk", 2000);
  }

  reset() {
    for (const r of ROLES) this.setStuck(r, false);
    for (const r of ROLES) { const a = this.actors[r]; if (a.pose === "slump" || a.pose === "stretch") a.pose = undefined; }
    for (const r of ROLES) this.setTag(r, null);
    this.tickets = [];
    this.prNote = null;
    this.celebrateUntil = {};
    for (const r of ROLES) {
      const a = this.actors[r];
      a.working = false; a.waiting = false; a.busy = false; a.bubble = undefined;
      if (a.pose === "lie") { a.pose = undefined; a.x = SOFA.approach.x; a.y = SOFA.approach.y; a.mode = "stand"; }
      void this.sit(r);
    }
  }

  // ---------- drawing ----------
  private draw(t: number) {
    const { ctx } = this;
    const { s, ox, oy, dpr, w, h } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0908";
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    ctx.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.bg, 0, 0);
    this.drawRain(t);
    this.drawTickets();
    this.drawPrNote();
    for (const l of this.layers) l.back?.(ctx, t);

    // light
    ctx.globalCompositeOperation = "lighter";
    LAMPS.forEach((l, i) => {
      const a = l.a * (0.9 + 0.1 * Math.sin(t / 700 + i * 1.7)) * (1 - 0.75 * this.dim);
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      g.addColorStop(0, `rgba(255,170,80,${a})`);
      g.addColorStop(1, "rgba(255,140,60,0)");
      ctx.fillStyle = g;
      ctx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    });
    for (const r of ROLES) {
      const a = this.actors[r];
      if (!a.working || a.mode !== "sit") continue;
      const m = SEATS[r].monitor;
      const al = 0.22 + 0.06 * Math.sin(t / 90 + a.phase);
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 46);
      g.addColorStop(0, `rgba(150,215,255,${al})`);
      g.addColorStop(1, "rgba(120,190,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(m.x - 46, m.y - 46, 92, 92);
    }
    ctx.globalCompositeOperation = "source-over";

    this.grabChairBacks();
    // characters, back to front
    const order = ROLES.map((r) => this.actors[r]).sort((a, b) => a.y - b.y);
    for (const a of order) {
      const fr = this.frameFor(a, t);
      const f = FRAMES[fr.name];
      if (!f) continue;
      if (a.mode !== "sit" && a.pose !== "lie") {
        ctx.fillStyle = "rgba(10,6,4,0.35)";
        ctx.beginPath();
        ctx.ellipse(a.x, a.y - 1, f.w * 0.36, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.save();
      if (a.pose && a.poseUntil !== undefined && performance.now() > a.poseUntil) a.pose = undefined;
      if (a.pose === "lie") { this.drawLying(a, t); ctx.restore(); continue; }
      const seated = a.mode === "sit";
      if (fr.desk) {
        // behind the desk: everything below the desk's (sloped) back edge is hidden by the desk
        const x0 = a.x - 80, x1 = a.x + 80;
        ctx.beginPath();
        ctx.moveTo(x0, a.y - 220); ctx.lineTo(x1, a.y - 220);
        ctx.lineTo(x1, deskEdgeY(fr.desk, x1)); ctx.lineTo(x0, deskEdgeY(fr.desk, x0));
        ctx.closePath();
        ctx.clip();
      }
      const until = this.celebrateUntil[a.role] ?? 0;
      // a cheer hops a standing agent; a seated one only bounces in the chair, never off it
      const hop = t < until ? Math.abs(Math.sin(t / 140)) * (seated ? 2 : 9) : 0;
      // dozing: the head sinks (and bobs with the breath); a slump sinks less
      const sink = a.pose === "sleep" ? 4 + Math.round(Math.sin(t / 900 + a.phase)) : a.pose === "slump" ? 3 : 0;
      const dx = Math.round(a.x - f.w / 2), dy = Math.round(a.y - f.h - hop + sink);
      // a stuck agent (insights) sways while scratching its head
      const stuck = this.stuck.has(a.role);
      // (seated: it pivots on the hips in the chair, so the sway never lifts them off the cushion)
      const pivot = seated ? SEATS[a.role].chair : a;
      if (stuck) { ctx.translate(pivot.x, pivot.y); ctx.rotate(Math.sin(t / 160) * 0.045); ctx.translate(-pivot.x, -pivot.y); }
      if (a.pose === "stretch") {
        // stretch: taller for a moment, from the feet up (seated: from the hips, so they stay in the chair)
        const k = 1 + 0.09 * Math.abs(Math.sin(t / 260));
        const base = seated ? Math.min(a.y, SEATS[a.role].chair.y + 4) : a.y;
        ctx.translate(Math.round(a.x), Math.round(base));
        ctx.scale(fr.flip ? -1 : 1, k);
        ctx.drawImage(this.atlas, f.x, f.y, f.w, f.h, -Math.round(f.w / 2), -f.h + Math.round(a.y - base), f.w, f.h);
      } else if (fr.flip) {
        ctx.translate(dx + f.w, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(this.atlas, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      } else ctx.drawImage(this.atlas, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
      ctx.restore();
      if (seated) this.drawChairBack(a.role);
      if (stuck) this.drawScratch(a, f, t);
    }

    // lightning flash on the window
    if (t < this.flashUntil) {
      ctx.fillStyle = "rgba(220,230,255,0.22)";
      this.windowPath();
      ctx.fill();
    }
    for (const l of this.layers) l.top?.(ctx, t);
    this.placeOverlays(t, order);
    for (const l of this.layers) l.place?.(t);
  }

  /**
   * Copies the finished room (lights, glow, layers) under each occupied back-facing chair's backrest,
   * in device pixels, so drawChairBack can lay the backrest over its sitter exactly as it was painted.
   */
  private grabChairBacks() {
    const { s, ox, oy, dpr } = this.view;
    const src = this.ctx.canvas;
    for (const r of ROLES) {
      const pts = SEATS[r].chairBack;
      const prev = this.chairPatches[r];
      if (prev) prev.ok = false;
      const a = this.actors[r];
      if (!pts || a.mode !== "sit" || a.pose === "lie") continue;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.max(0, Math.floor((Math.min(...xs) * s + ox) * dpr) - 2);
      const y = Math.max(0, Math.floor((Math.min(...ys) * s + oy) * dpr) - 2);
      const x2 = Math.min(src.width, Math.ceil((Math.max(...xs) * s + ox) * dpr) + 2);
      const y2 = Math.min(src.height, Math.ceil((Math.max(...ys) * s + oy) * dpr) + 2);
      if (x2 <= x || y2 <= y) continue;
      const p = prev ?? (this.chairPatches[r] = { c: document.createElement("canvas"), x: 0, y: 0, ok: false });
      const w = x2 - x, h = y2 - y;
      if (p.c.width !== w || p.c.height !== h) { p.c.width = w; p.c.height = h; }
      const pc = p.c.getContext("2d");
      if (!pc) continue;
      pc.clearRect(0, 0, w, h);
      pc.drawImage(src, x, y, w, h, 0, 0, w, h);
      p.x = x; p.y = y; p.ok = true;
    }
  }

  /** the chair's backrest is nearer the viewer than its (back-facing) sitter: paint it back over them */
  private drawChairBack(role: Role) {
    const pts = SEATS[role].chairBack;
    const p = this.chairPatches[role];
    if (!pts || !p?.ok) return;
    const c = this.ctx;
    c.save();
    c.beginPath();
    pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.closePath();
    c.clip();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(p.c, p.x, p.y);
    c.restore();
  }

  /** a character lying on the bench, seen above its backrest */
  private drawLying(a: Actor, t: number) {
    const c = this.ctx;
    const f = FRAMES[`${a.role}_idle`];
    if (!f) return;
    const b = SOFA.backTop;
    c.save();
    // only what is above the backrest's top edge shows
    c.beginPath();
    c.moveTo(b.x0 - 80, b.y0 + 80 * -b.slope - 0);
    c.lineTo(b.x0 - 80, 0);
    c.lineTo(b.x0 + 200, 0);
    c.lineTo(b.x0 + 200, b.y0 + 200 * b.slope);
    c.closePath();
    c.clip();
    const breathe = Math.sin(t / 900 + a.phase) * 0.6;
    c.translate(SOFA.seat.x, SOFA.seat.y + breathe);
    c.rotate(SOFA.angle - Math.PI / 2);
    c.drawImage(this.atlas, f.x, f.y, f.w, f.h, -Math.round(f.w / 2), -Math.round(f.h / 2), f.w, f.h);
    c.restore();
  }

  /** A hand scratching the head: a small skin-coloured block bobbing over the hair, with scratch marks. */
  private drawScratch(a: Actor, f: Frame, t: number) {
    const c = this.ctx;
    const up = Math.sin(t / 70) > 0 ? 0 : 3;
    const hx = Math.round(a.x + (a.flip ? -1 : 1) * f.w * 0.16), hy = Math.round(a.y - f.h + 7 + up);
    c.fillStyle = "#e9b48a";
    c.fillRect(hx - 3, hy - 3, 6, 6);
    c.fillStyle = "#141210";
    c.fillRect(hx - 3, hy + 3, 6, 1);
    if (up === 0) {
      c.fillStyle = "rgba(255,240,220,.9)";
      c.fillRect(hx + 5, hy - 7, 2, 4);
      c.fillRect(hx + 8, hy - 3, 3, 2);
      c.fillRect(hx - 9, hy - 6, 2, 3);
    }
  }

  private windowPath() {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(WINDOW[0].x, WINDOW[0].y);
    for (let i = 1; i < 4; i++) c.lineTo(WINDOW[i].x, WINDOW[i].y);
    c.closePath();
  }

  private drawRain(t: number) {
    const c = this.ctx;
    c.save();
    this.windowPath();
    c.clip();
    c.strokeStyle = "rgba(170,195,240,0.38)";
    c.lineWidth = 1;
    c.beginPath();
    const dt = 1 / 60;
    for (const d of this.drops) {
      d.v += d.sp * dt;
      if (d.v > 1.1) { d.v = -0.1; d.u = (d.u + 0.618) % 1; }
      const a = quad(WINDOW, d.u, d.v), b = quad(WINDOW, d.u - 0.004, d.v + d.l);
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
    }
    c.stroke();
    c.restore();
    void t;
  }

  private drawPrNote() {
    if (!this.prNote) return;
    const c = this.ctx;
    const u0 = 0.56, v0 = 0.6, du = 0.36, dv = 0.3;
    const p = [quad(BOARD, u0, v0), quad(BOARD, u0 + du, v0), quad(BOARD, u0 + du, v0 + dv), quad(BOARD, u0, v0 + dv)];
    c.fillStyle = "#e8742f";
    c.strokeStyle = "#2a1c14";
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(p[0].x, p[0].y);
    p.slice(1).forEach((q) => c.lineTo(q.x, q.y));
    c.closePath();
    c.fill();
    c.stroke();
    // text along the board's slant
    const a = quad(BOARD, u0 + 0.03, v0 + dv * 0.62), b = quad(BOARD, u0 + du, v0 + dv * 0.62);
    c.save();
    c.translate(a.x, a.y);
    c.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    c.fillStyle = "#1b0f06";
    c.font = "700 11px monospace";
    c.fillText(this.prNote.slice(0, 10), 0, 0);
    c.restore();
  }

  private drawTickets() {
    if (!this.tickets.length) return;
    const c = this.ctx;
    const cols = 4;
    const color = { todo: "#ecd27a", doing: "#ef9a55", done: "#a6d38c" } as const;
    this.tickets.slice(0, 8).forEach((tk, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const u0 = 0.08 + col * 0.22, v0 = 0.16 + row * 0.38, du = 0.14, dv = 0.24;
      const p = [quad(BOARD, u0, v0), quad(BOARD, u0 + du, v0), quad(BOARD, u0 + du, v0 + dv), quad(BOARD, u0, v0 + dv)];
      c.fillStyle = color[tk.status];
      c.strokeStyle = "#2a1c14";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(p[0].x, p[0].y);
      p.slice(1).forEach((q) => c.lineTo(q.x, q.y));
      c.closePath();
      c.fill();
      c.stroke();
      // two scribble lines
      c.strokeStyle = "rgba(40,28,20,0.55)";
      c.beginPath();
      for (const k of [0.35, 0.6]) {
        const a = quad(BOARD, u0 + 0.03, v0 + dv * k), b = quad(BOARD, u0 + du - 0.04, v0 + dv * k);
        c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
      }
      c.stroke();
      if (tk.status === "done") {
        const a = quad(BOARD, u0 + 0.04, v0 + dv * 0.78), m = quad(BOARD, u0 + 0.07, v0 + dv * 0.95), b = quad(BOARD, u0 + 0.13, v0 + dv * 0.62);
        c.strokeStyle = "#1d4d17";
        c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(m.x, m.y); c.lineTo(b.x, b.y); c.stroke();
      }
    });
  }

  private placeOverlays(t: number, order: Actor[]) {
    const now = performance.now();
    order.forEach((a, i) => {
      const fr = this.frameFor(a, t);
      const f = FRAMES[fr.name];
      const lying = a.pose === "lie";
      const top = lying ? SOFA.seat.y - 26 : a.y - f.h;
      const p = this.toScreen({ x: lying ? SOFA.seat.x : a.x, y: top });
      const base = this.toScreen({ x: a.x, y: lying ? SOFA.seat.y + 6 : a.y });
      a.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      a.el.style.height = Math.max(20, base.y - p.y) + "px";
      a.el.style.zIndex = String(10 + i);
      if (a.bubble && now > a.bubble.until) a.bubble = undefined;
      const b = a.bubble;
      if (b) {
        if (a.bub.textContent !== b.text) a.bub.textContent = b.text;
        a.bub.dataset.kind = b.kind;
        a.bub.hidden = false;
      } else a.bub.hidden = true;
      a.el.classList.toggle("is-working", a.working);
      a.el.classList.toggle("is-waiting", a.waiting);
      a.el.classList.toggle("is-asleep", a.pose === "sleep" || a.pose === "lie");
    });
  }
}

/** crops a portrait out of the atlas as a data URL for the UI */
export function portraitURL(atlas: HTMLImageElement, role: Role): string {
  const f = FRAMES[`${role}_portrait`];
  const c = document.createElement("canvas");
  c.width = f.w;
  c.height = f.h;
  c.getContext("2d")!.drawImage(atlas, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  try {
    return c.toDataURL();
  } catch {
    return "";
  }
}
