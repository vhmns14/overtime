// The pixel office: a pre-rendered isometric room (generated art) with sprite characters walking a
// small nav graph, typing at desks, meeting at the round table, updating the whiteboard and
// fetching coffee. Lamp glow, monitor light and rain are drawn live on a 2D canvas.

import atlasJson from "./atlas.json";
import { BG, BOARD, LAMPS, ROOM, SEATS, SPOTS, WINDOW, dist, findPath, quad, type Pt } from "./layout";
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

export class Office {
  private ctx: CanvasRenderingContext2D;
  private actors = {} as Record<Role, Actor>;
  private view = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
  private drops: { u: number; v: number; l: number; sp: number }[] = [];
  private tickets: Ticket[] = [];
  private raf = 0;
  private last = 0;
  private flashUntil = 0;
  private nextFlash = 0;
  private nextAmbient = 0;
  private rand = rng(20261019);
  private ro: ResizeObserver;
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
    let s = Math.min(W / ROOM.w, H / ROOM.h) * 1.08;
    let cx = ROOM.x + ROOM.w / 2, cy = ROOM.y + ROOM.h / 2;
    if (W < 680 || W / Math.max(1, H) < 0.9) {
      // narrow (phone): zoom into the desk cluster like the mobile mockup
      s = Math.max(s, Math.min(H / 520, W / 560));
      cx = 560; cy = 500;
    }
    let ox = W / 2 - cx * s, oy = H / 2 - cy * s;
    if (BG.w * s > W) ox = Math.max(W - BG.w * s, Math.min(0, ox));
    if (BG.h * s > H) oy = Math.max(H - BG.h * s, Math.min(0, oy));
    this.view = { s, ox, oy, w: W, h: H, dpr };
  }
  private toBg(x: number, y: number): Pt { return { x: (x - this.view.ox) / this.view.s, y: (y - this.view.oy) / this.view.s }; }
  private toScreen(p: Pt): Pt { return { x: p.x * this.view.s + this.view.ox, y: p.y * this.view.s + this.view.oy }; }

  private frameFor(a: Actor, t: number): { name: string; flip: boolean; clipY?: number } {
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
    if (seat.facing === "front" && FRAMES[`${r}_fsitA`]) return { name: `${r}_${typing ? "fsitB" : "fsitA"}`, flip: false, clipY: seat.clipY };
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
      const idle = ROLES.filter((r) => { const a = this.actors[r]; return !a.working && !a.busy && !a.waiting && a.mode === "sit"; });
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

  reset() {
    this.tickets = [];
    for (const r of ROLES) {
      const a = this.actors[r];
      a.working = false; a.waiting = false; a.busy = false; a.bubble = undefined;
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

    // light
    ctx.globalCompositeOperation = "lighter";
    LAMPS.forEach((l, i) => {
      const a = l.a * (0.9 + 0.1 * Math.sin(t / 700 + i * 1.7));
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

    // characters, back to front
    const order = ROLES.map((r) => this.actors[r]).sort((a, b) => a.y - b.y);
    for (const a of order) {
      const fr = this.frameFor(a, t);
      const f = FRAMES[fr.name];
      if (!f) continue;
      if (a.mode !== "sit") {
        ctx.fillStyle = "rgba(10,6,4,0.35)";
        ctx.beginPath();
        ctx.ellipse(a.x, a.y - 1, f.w * 0.36, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.save();
      if (fr.clipY !== undefined) { ctx.beginPath(); ctx.rect(a.x - 80, a.y - 200, 160, 200 - (a.y - fr.clipY)); ctx.clip(); }
      const dx = Math.round(a.x - f.w / 2), dy = Math.round(a.y - f.h);
      if (fr.flip) {
        ctx.translate(dx + f.w, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(this.atlas, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      } else ctx.drawImage(this.atlas, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
      ctx.restore();
    }

    // lightning flash on the window
    if (t < this.flashUntil) {
      ctx.fillStyle = "rgba(220,230,255,0.22)";
      this.windowPath();
      ctx.fill();
    }
    this.placeOverlays(t, order);
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
      const top = fr.clipY !== undefined ? a.y - f.h : a.y - f.h;
      const p = this.toScreen({ x: a.x, y: top });
      const base = this.toScreen({ x: a.x, y: a.y });
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
