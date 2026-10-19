// The office reacts to activity: lamps dim and monitors switch off when Hermes goes quiet, everyone
// dozes off (one on the bench) and stretches awake on the next session, a wall scoreboard counts
// today's sessions, a cheer or a slump follows each turn, the clock shows the viewer's real local
// time, the window follows the day, the bookshelf holds one book per Hermes skill and the filing
// cabinet glows when memory is written or recalled.
//
// Everything is drawn as an OfficeLayer on top of the pre-rendered room, from the generated props
// atlas (scripts/build-props.py). Pure logic lives in activity.ts, ext/library.ts, ext/scoreboard.ts.

import propsJson from "./props-atlas.json";
import { type Office, type OfficeLayer } from "./scene";
import { WINDOW } from "./layout";
import { DEFAULT_ACTIVITY, initActivity, onActivity, tickActivity, type Activity, type ActivityConfig, type ActivityState } from "./activity";
import { bookLabel, shelf, type LibraryState, type SkillBook } from "../ext/library";
import { score, type Scoreboard } from "../ext/scoreboard";
import { pixText, textWidth } from "./pixfont";
import { ROLES, type Role } from "../engine/types";
import type { Pt } from "./layout";

type Frame = { x: number; y: number; w: number; h: number };
interface PropsMeta {
  frames: Record<string, Frame>;
  spines: number;
  place: {
    bookcase: { x: number; y: number; w: number; h: number };
    cabinet: { x: number; y: number; h: number };
    scoreboard: { x: number; y: number; w: number; h: number; shear: number };
    plantOccluder: { x: number; y: number };
    shelves: { slope: number; x0: number; x1: number; baselines: number[] };
  };
}
const P = propsJson as unknown as PropsMeta;
const F = P.frames;

/** monitor screens that face the viewer (they are baked in "on"): tl, tr, br, bl */
const SCREENS: [Pt, Pt, Pt, Pt][] = [
  [{ x: 431, y: 446 }, { x: 478, y: 422 }, { x: 479, y: 460 }, { x: 432, y: 484 }],
  [{ x: 601, y: 546 }, { x: 645, y: 524 }, { x: 645, y: 558 }, { x: 601, y: 582 }],
  [{ x: 430, y: 637 }, { x: 476, y: 613 }, { x: 476, y: 649 }, { x: 430, y: 672 }],
];
/** the wall clock: centre, face radius, and the wall's slope (a circle on the wall is sheared) */
const CLOCK = { x: 487, y: 105, r: 13.5, shear: -0.51, face: "#c39571", ink: "#2a1408" };
const SB_INNER = { left: { x: 8, y: 22, w: 34 }, right: { x: 45, y: 22, w: 34 }, plaque: { x: 10, y: 11, w: 67 } };
const SLEEP_ON_SOFA: Role = "reviewer";

export interface AmbienceOptions {
  activity?: ActivityConfig;
  /** the viewer's clock (tests and screenshots can pin it) */
  clock?: () => Date;
  /** a book, the bookcase or the cabinet was clicked */
  onOpenLibrary?: (skill?: string) => void;
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; c: string; kind: "confetti" | "z" | "spark" }

export class Ambience implements OfficeLayer {
  act: ActivityState;
  cfg: ActivityConfig;
  /** false on the built-in team surface: the office stays awake there */
  auto = true;
  private dimNow = 0;
  private dimTarget = 0;
  private monitorsOff = 0;
  private monitorsTarget = 0;
  private books: SkillBook[] = [];
  private bookFx: Record<string, { kind: "added" | "improved"; at: number }> = {};
  private lib: LibraryState | null = null;
  private board: Scoreboard | null = null;
  private teamScore = { ok: 0, fail: 0 };
  private sbFlash: { side: "ok" | "fail"; at: number } | null = null;
  private cabinetFx: { op: "write" | "recall"; at: number } | null = null;
  private parts: Particle[] = [];
  private lastFrame = 0;
  private nextZ = 0;
  private timer = 0;
  private hot: HTMLElement;
  private tip: HTMLElement;
  private hotKey = "";
  private clock: () => Date;

  constructor(private office: Office, private img: HTMLImageElement, root: HTMLElement, private opts: AmbienceOptions = {}) {
    this.cfg = opts.activity ?? DEFAULT_ACTIVITY;
    this.clock = opts.clock ?? (() => new Date());
    this.act = initActivity(Date.now(), null, this.cfg);
    this.hot = document.createElement("div");
    this.hot.className = "prop-layer";
    root.appendChild(this.hot);
    this.tip = document.createElement("div");
    this.tip.className = "prop-tip";
    this.tip.hidden = true;
    this.tip.setAttribute("role", "tooltip");
    root.appendChild(this.tip);
    office.addLayer(this);
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  destroy() { clearInterval(this.timer); }

  // ---------- inputs ----------
  /** (Re)start from history: no wake-up show for an office that has been asleep for hours. */
  reset(lastEventAt: number | null, holding = false) {
    this.parts = [];
    const prev = this.act.mode;
    this.act = initActivity(Date.now(), lastEventAt, this.cfg, holding);
    if (!this.auto) this.act = { ...this.act, mode: "active" };
    this.enter(this.act.mode, prev, false);
  }

  /** Hermes did something. */
  event(ts: number, holding = false) {
    if (!this.auto) return;
    const st = onActivity(this.act, ts, Date.now(), this.cfg, holding);
    this.act = st.state;
    if (st.changed) this.enter(st.changed.to, st.changed.from, true);
  }

  setLibrary(lib: LibraryState) {
    this.lib = lib;
    const next = shelf(lib);
    if (next.length !== this.books.length || next.some((b, i) => b !== this.books[i] || b.versions !== this.books[i].versions)) this.hotKey = "";
    this.books = next.slice();
  }

  setScoreboard(board: Scoreboard | null) { this.board = board; }

  /** the built-in team's runs today (when no Hermes scoreboard is shown) */
  setTeamScore(ok: number, fail: number) { this.teamScore = { ok, fail }; }

  book(name: string, change: string, versions: number, live: boolean) {
    this.hotKey = "";
    if (!live) return;
    if (change === "added" || change === "improved") {
      this.bookFx[name] = { kind: change, at: performance.now() };
      this.office.say("pm", change === "added" ? `New skill: ${name.slice(0, 28)}` : `Improved ${name.slice(0, 22)} · v${versions}`, "talk", 2600);
      const p = this.bookPos(name);
      if (p) this.burst(p.x + 2, p.y - 8, 10, "spark", ["#ffe08a", "#fff3c4", "#e8742f"]);
    }
  }

  cabinet(op: "write" | "recall", live: boolean) {
    if (!live) return;
    this.cabinetFx = { op, at: performance.now() };
  }

  outcome(ok: boolean, live: boolean) {
    this.sbFlash = { side: ok ? "ok" : "fail", at: performance.now() };
    if (!live) return;
    if (ok) {
      this.office.cheer(["Nice!", "Shipped it!", "Done and dusted!", "That worked!"][Math.floor(Math.random() * 4)]);
      this.burst(600, 250, 70, "confetti", ["#e8742f", "#ecd27a", "#a6d38c", "#7fb8e8", "#f3eee4", "#ef9a55"]);
    } else this.office.slump(["Oof.", "That one failed.", "Back to the drawing board."][Math.floor(Math.random() * 3)]);
  }

  /** current mode, for the status chip and tests */
  get mode(): Activity { return this.act.mode; }

  // ---------- state machine glue ----------
  private tick() {
    if (!this.auto) return;
    const st = tickActivity(this.act, Date.now(), this.cfg);
    this.act = st.state;
    if (st.changed) this.enter(st.changed.to, st.changed.from, true);
  }

  private enter(to: Activity, from: Activity, show: boolean) {
    const o = this.office;
    document.documentElement.dataset.officeMode = to;
    if (to === "active" || to === "waking") {
      this.dimTarget = 0;
      this.monitorsTarget = 0;
      if (from === "asleep" || to === "waking") for (const r of ROLES) void o.wake(r, show);
    } else if (to === "idle") {
      this.dimTarget = 0.55;
      this.monitorsTarget = 1;
      if (from === "asleep") for (const r of ROLES) void o.wake(r, false);
    } else if (to === "asleep") {
      this.dimTarget = 1;
      this.monitorsTarget = 1;
      for (const r of ROLES) void o.sleep(r, r === SLEEP_ON_SOFA);
    }
    if (!show) { this.dimNow = this.dimTarget; this.monitorsOff = this.monitorsTarget; }
    this.hotKey = "";
  }

  // ---------- drawing ----------
  back(ctx: CanvasRenderingContext2D, t: number) {
    const dt = Math.min(0.1, (t - (this.lastFrame || t)) / 1000);
    this.lastFrame = t;
    this.dimNow += (this.dimTarget - this.dimNow) * Math.min(1, dt * 1.6);
    this.monitorsOff += (this.monitorsTarget - this.monitorsOff) * Math.min(1, dt * 4);
    this.office.dim = this.dimNow;
    const now = this.clock();
    this.drawWindow(ctx, now);
    this.drawClock(ctx, now);
    this.drawScoreboard(ctx, t);
    this.drawBookcase(ctx, t);
    this.drawCabinet(ctx, t);
    if (this.monitorsOff > 0.02) this.drawScreensOff(ctx);
  }

  top(ctx: CanvasRenderingContext2D, t: number) {
    if (this.dimNow > 0.01) {
      ctx.fillStyle = `rgba(10,8,22,${(0.38 * this.dimNow).toFixed(3)})`;
      ctx.fillRect(0, 0, 1195, 896);
    }
    this.spawnZ(t);
    this.drawParticles(ctx);
  }

  private frame(ctx: CanvasRenderingContext2D, name: string, dx: number, dy: number) {
    const f = F[name];
    if (f) ctx.drawImage(this.img, f.x, f.y, f.w, f.h, dx, dy, f.w, f.h);
  }

  /** 0 at night, 1 at midday, smooth at dawn and dusk */
  static daylight(d: Date): number {
    const h = d.getHours() + d.getMinutes() / 60;
    const ramp = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));
    return Math.min(ramp(h, 5.5, 7.5), 1 - ramp(h, 17.5, 19.5));
  }

  private drawWindow(ctx: CanvasRenderingContext2D, now: Date) {
    const day = Ambience.daylight(now);
    if (day <= 0.01) return;
    const h = now.getHours() + now.getMinutes() / 60;
    const dusk = Math.max(0, 1 - Math.abs(h - (h < 12 ? 6.5 : 18.5)) / 1.2); // warm at dawn and dusk
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(WINDOW[0].x, WINDOW[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(WINDOW[i].x, WINDOW[i].y);
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 110, 0, 398);
    const top = dusk > 0.3 ? `rgba(122,150,200,${0.8 * day})` : `rgba(136,180,226,${0.82 * day})`;
    const bot = dusk > 0.3 ? `rgba(240,170,120,${0.85 * day})` : `rgba(206,226,240,${0.8 * day})`;
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fillRect(110, 100, 310, 310);
    // daytime skyline: a few flat blocks, like the night city with its lights off
    ctx.fillStyle = `rgba(112,132,158,${0.32 * day})`;
    for (const [u, w, hgt] of [[0.04, 0.12, 0.4], [0.2, 0.09, 0.55], [0.33, 0.14, 0.32], [0.52, 0.1, 0.48], [0.67, 0.16, 0.38], [0.86, 0.1, 0.5]] as const) {
      const x0 = WINDOW[0].x + (WINDOW[1].x - WINDOW[0].x) * u, x1 = x0 + (WINDOW[1].x - WINDOW[0].x) * w;
      const yb0 = WINDOW[3].y + (WINDOW[2].y - WINDOW[3].y) * u, yb1 = WINDOW[3].y + (WINDOW[2].y - WINDOW[3].y) * (u + w);
      const hh = (WINDOW[3].y - WINDOW[0].y) * hgt;
      ctx.beginPath();
      ctx.moveTo(x0, yb0); ctx.lineTo(x0, yb0 - hh); ctx.lineTo(x1, yb1 - hh); ctx.lineTo(x1, yb1); ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawClock(ctx: CanvasRenderingContext2D, now: Date) {
    const c = CLOCK;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.transform(1, c.shear, 0, 1, 0, 0);
    ctx.fillStyle = c.face;
    ctx.beginPath();
    ctx.arc(0, 0, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7c4a2c";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const big = i % 3 === 0;
      ctx.fillRect(Math.round(Math.sin(a) * 10.5) - (big ? 1 : 0.5), Math.round(-Math.cos(a) * 10.5) - (big ? 1 : 0.5), big ? 2 : 1, big ? 2 : 1);
    }
    const hm = now.getHours() % 12 + now.getMinutes() / 60, mm = now.getMinutes() + now.getSeconds() / 60;
    const hand = (ang: number, len: number, w: number, col: string) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.lineCap = "square";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(ang) * len, -Math.cos(ang) * len);
      ctx.stroke();
    };
    hand((hm / 12) * Math.PI * 2, 6.5, 2, c.ink);
    hand((mm / 60) * Math.PI * 2, 9.5, 1.5, c.ink);
    hand((now.getSeconds() / 60) * Math.PI * 2, 10, 0.8, "#b03a1e");
    ctx.fillStyle = c.ink;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  private scoreNow(): { ok: number; fail: number } {
    return this.board ? score(this.board, this.clock().getTime()) : this.teamScore;
  }

  private drawScoreboard(ctx: CanvasRenderingContext2D, t: number) {
    const sb = P.place.scoreboard;
    const { ok, fail } = this.scoreNow();
    ctx.save();
    ctx.translate(sb.x, sb.y);
    ctx.transform(1, sb.shear, 0, 1, 0, 0);
    this.frame(ctx, "scoreboard", 0, 0);
    const pl = SB_INNER.plaque;
    pixText(ctx, "TODAY", pl.x + Math.round((pl.w - textWidth("TODAY")) / 2), pl.y + 1, 1, "#4a2610");
    const flash = this.sbFlash && performance.now() - this.sbFlash.at < 1800 ? this.sbFlash.side : null;
    const blink = flash && Math.floor((performance.now() - this.sbFlash!.at) / 180) % 2 === 0;
    const half = (side: "ok" | "fail", n: number) => {
      const box = side === "ok" ? SB_INNER.left : SB_INNER.right;
      const lit = side === "ok" ? "#a6d38c" : "#ef7a55";
      const dimc = side === "ok" ? "#4f6b45" : "#7a3b2c";
      const col = n > 0 || (flash === side && blink) ? lit : dimc;
      const label = side === "ok" ? "✓ OK" : "✗ FAIL";
      pixText(ctx, label, box.x + Math.round((box.w - textWidth(label)) / 2), box.y + 5, 1, col);
      const txt = n > 99 ? "99" : String(n);
      const scale = 4;
      pixText(ctx, txt, box.x + Math.round((box.w - textWidth(txt, scale)) / 2), box.y + 17, scale, flash === side && blink ? "#fff6dc" : col);
    };
    half("ok", ok);
    half("fail", fail);
    ctx.restore();
    void t;
  }

  // books along each shelf, sheared to the bookcase front
  private layoutBooks(): { b: SkillBook; x: number; y: number; f: Frame }[] {
    const s = P.place.shelves;
    const out: { b: SkillBook; x: number; y: number; f: Frame }[] = [];
    let row = 0, x = s.x0;
    for (const b of this.books) {
      const f = F[`spine${b.spine % Math.max(1, P.spines)}`];
      if (!f) continue;
      if (x + f.w > s.x1) { row++; x = s.x0; }
      if (row >= s.baselines.length) break;
      out.push({ b, x, y: s.baselines[row] + (x - s.x0) * s.slope, f });
      x += f.w;
    }
    return out;
  }

  private bookPos(name: string): Pt | null {
    const p = this.layoutBooks().find((l) => l.b.name === name);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** books that did not fit on the shelf */
  get overflow(): number { return Math.max(0, this.books.length - this.layoutBooks().length); }

  private drawBookcase(ctx: CanvasRenderingContext2D, t: number) {
    const bc = P.place.bookcase;
    this.frame(ctx, "bookcase", bc.x, bc.y);
    const now = performance.now();
    const slope = P.place.shelves.slope;
    for (const l of this.layoutBooks()) {
      const fx = this.bookFx[l.b.name];
      const age = fx ? now - fx.at : Infinity;
      const drop = fx?.kind === "added" && age < 700 ? Math.round((1 - age / 700) * 10) : 0;
      ctx.save();
      ctx.translate(l.x, l.y - drop);
      ctx.transform(1, slope, 0, 1, 0, 0);
      if (fx?.kind === "added" && age < 700) ctx.globalAlpha = Math.min(1, age / 300);
      ctx.drawImage(this.img, l.f.x, l.f.y, l.f.w, l.f.h, 0, -l.f.h, l.f.w, l.f.h);
      if (fx && age < 1600) {
        // a glint runs up the spine
        const k = (age % 800) / 800;
        ctx.globalAlpha = 0.9 * (1 - age / 1600);
        ctx.fillStyle = "#fff3c4";
        ctx.fillRect(0, -Math.round(l.f.h * k) - 2, l.f.w, 2);
      }
      ctx.restore();
    }
    for (const k of Object.keys(this.bookFx)) if (now - this.bookFx[k].at > 2000) delete this.bookFx[k];
    // the plant stands in front of the bookcase
    this.frame(ctx, "plant_front", P.place.plantOccluder.x, P.place.plantOccluder.y);
    void t;
  }

  private drawCabinet(ctx: CanvasRenderingContext2D, t: number) {
    const cab = P.place.cabinet;
    const f = F.cabinet;
    this.frame(ctx, "cabinet", cab.x, cab.y);
    const fx = this.cabinetFx;
    if (!fx) return;
    const age = performance.now() - fx.at;
    if (age > 2600) { this.cabinetFx = null; return; }
    const k = age < 300 ? age / 300 : 1 - (age - 300) / 2300;
    const cx = cab.x + f.w * 0.42, cy = cab.y + f.h * 0.55;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const col = fx.op === "write" ? "255,178,90" : "120,210,255";
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 70);
    g.addColorStop(0, `rgba(${col},${(0.55 * k).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - 70, cy - 70, 140, 140);
    // the drawer that was used lights up along its front
    const drawer = fx.op === "write" ? 1 : 2;
    const dy = cab.y + f.h * (0.3 + drawer * 0.17);
    ctx.fillStyle = `rgba(${col},${(0.65 * k).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(cab.x + f.w * 0.08, dy);
    ctx.lineTo(cab.x + f.w * 0.5, dy + f.w * 0.2);
    ctx.lineTo(cab.x + f.w * 0.5, dy + f.w * 0.2 + 3);
    ctx.lineTo(cab.x + f.w * 0.08, dy + 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (age < 60 && fx.op === "write") this.burst(cx, cab.y + 8, 6, "spark", ["#ffe08a", "#fff3c4"]);
    void t;
  }

  private drawScreensOff(ctx: CanvasRenderingContext2D) {
    ctx.save();
    for (const q of SCREENS) {
      ctx.globalAlpha = this.monitorsOff;
      ctx.fillStyle = "#15181d";
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
      ctx.closePath();
      ctx.fill();
      // a faint reflection
      ctx.strokeStyle = "rgba(120,140,170,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q[0].x + 4, q[0].y + 8);
      ctx.lineTo(q[0].x + 14, q[0].y + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- particles ----------
  private burst(x: number, y: number, n: number, kind: Particle["kind"], colors: string[]) {
    for (let i = 0; i < n; i++) {
      const a = kind === "confetti" ? -Math.PI / 2 + (Math.random() - 0.5) * 2.2 : Math.random() * Math.PI * 2;
      const sp = kind === "confetti" ? 140 + Math.random() * 160 : 30 + Math.random() * 40;
      const life = kind === "confetti" ? 1.8 + Math.random() * 0.8 : 0.6 + Math.random() * 0.4;
      this.parts.push({ x: x + (Math.random() - 0.5) * (kind === "confetti" ? 360 : 6), y, vx: Math.cos(a) * sp * (kind === "confetti" ? 0.6 : 1), vy: Math.sin(a) * sp, life, max: life, c: colors[i % colors.length], kind });
    }
    if (this.parts.length > 400) this.parts.splice(0, this.parts.length - 400);
  }

  private spawnZ(t: number) {
    if (t < this.nextZ) return;
    this.nextZ = t + 650;
    for (const r of ROLES) {
      const i = this.office.actorInfo(r);
      if (i.pose !== "sleep" && i.pose !== "lie") continue;
      if (Math.random() < 0.55) this.parts.push({ x: i.head.x + 8, y: i.head.y - 4, vx: 6 + Math.random() * 6, vy: -16 - Math.random() * 6, life: 2.4, max: 2.4, c: "#dfe6ff", kind: "z" });
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    const dt = 1 / 60;
    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "confetti") { p.vy += 260 * dt; p.vx *= 0.99; }
      if (p.kind === "spark") p.vy += 40 * dt;
      if (p.kind === "z") p.vx = Math.sin((p.max - p.life) * 3) * 8;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    ctx.save();
    for (const p of this.parts) {
      const a = Math.min(1, p.life / (p.max * 0.4));
      ctx.globalAlpha = a;
      if (p.kind === "z") {
        const sc = p.max - p.life > 1.2 ? 2 : 1;
        pixText(ctx, "Z", Math.round(p.x), Math.round(p.y), sc, p.c);
      } else if (p.kind === "confetti") {
        ctx.fillStyle = p.c;
        const w = Math.abs(Math.sin(p.life * 9)) * 3 + 1;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(w), 3);
      } else {
        ctx.fillStyle = p.c;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
      }
    }
    ctx.restore();
  }

  // ---------- DOM hotspots: hover a book for its name and versions, click for the Library ----------
  place() {
    const o = this.office;
    const a = o.bgToScreen({ x: 0, y: 0 }), b = o.bgToScreen({ x: 100, y: 100 });
    const key = `${a.x.toFixed(1)},${a.y.toFixed(1)},${b.x.toFixed(1)},${this.books.length},${this.books.map((x) => x.versions + x.uses).join(".")},${this.scoreKey()},${this.memKey()}`;
    if (key === this.hotKey) return;
    this.hotKey = key;
    const s = (b.x - a.x) / 100;
    const rect = (x: number, y: number, w: number, h: number) => {
      const p = o.bgToScreen({ x, y });
      return `left:${Math.round(p.x)}px;top:${Math.round(p.y)}px;width:${Math.max(6, Math.round(w * s))}px;height:${Math.max(6, Math.round(h * s))}px`;
    };
    const bc = P.place.bookcase, cab = P.place.cabinet, sb = P.place.scoreboard;
    const { ok, fail } = this.scoreNow();
    const m = this.lib?.memory;
    const nBooks = this.books.length;
    let html = `<button type="button" class="prop-hot prop-bookcase" data-prop="library" style="${rect(bc.x + 4, bc.y + 20, bc.w - 30, bc.h - 30)}" aria-label="Library: ${nBooks} skill${nBooks === 1 ? "" : "s"}" data-tip="Library · ${nBooks} skill${nBooks === 1 ? "" : "s"}${this.overflow ? ` (${this.overflow} more than fit on the shelf)` : ""}"></button>`;
    html += `<button type="button" class="prop-hot" data-prop="cabinet" style="${rect(cab.x, cab.y, F.cabinet.w, F.cabinet.h)}" aria-label="Memory" data-tip="Memory · ${m?.writes ?? 0} write${m?.writes === 1 ? "" : "s"} · ${m?.recalls ?? 0} recall${m?.recalls === 1 ? "" : "s"}"></button>`;
    html += `<button type="button" class="prop-hot" data-prop="scoreboard" style="${rect(sb.x, sb.y + sb.shear * sb.w, sb.w, sb.h - sb.shear * sb.w)}" aria-label="Today: ${ok} succeeded, ${fail} failed" data-tip="Today · ${ok} succeeded · ${fail} failed"></button>`;
    for (const l of this.layoutBooks()) {
      html += `<button type="button" class="prop-hot prop-book" data-prop="book" data-skill="${esc(l.b.name)}" style="${rect(l.x - 0.5, l.y - l.f.h, l.f.w + 1, l.f.h + 2)}" aria-label="Skill ${esc(bookLabel(l.b))}" data-tip="${esc(bookLabel(l.b))}"></button>`;
    }
    this.hot.innerHTML = html;
    for (const el of this.hot.querySelectorAll<HTMLElement>(".prop-hot")) {
      el.addEventListener("mouseenter", () => this.showTip(el));
      el.addEventListener("focus", () => this.showTip(el));
      el.addEventListener("mouseleave", () => { this.tip.hidden = true; });
      el.addEventListener("blur", () => { this.tip.hidden = true; });
      el.addEventListener("click", () => {
        this.showTip(el);
        const p = el.dataset.prop;
        if (p === "book" || p === "library" || p === "cabinet") this.opts.onOpenLibrary?.(el.dataset.skill);
      });
    }
  }

  private scoreKey() { const s = this.scoreNow(); return `${s.ok}-${s.fail}`; }
  private memKey() { const m = this.lib?.memory; return m ? `${m.writes}-${m.recalls}` : ""; }

  private showTip(el: HTMLElement) {
    const t = el.dataset.tip;
    if (!t) return;
    this.tip.textContent = t;
    this.tip.hidden = false;
    const r = el.getBoundingClientRect(), pr = (this.tip.parentElement as HTMLElement).getBoundingClientRect();
    const w = this.tip.offsetWidth;
    const x = Math.max(6, Math.min(pr.width - w - 6, r.left - pr.left + r.width / 2 - w / 2));
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(4, r.top - pr.top - this.tip.offsetHeight - 6))}px)`;
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
