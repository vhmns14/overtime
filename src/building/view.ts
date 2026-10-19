// The building view: a pixel cross-section of one building, one floor per Hermes install. Lit floors
// are working, dim ones are quiet, dark ones asleep. Click a floor (or its plate) to ride the
// elevator up and walk into that office.

import propsJson from "../office/props-atlas.json";
import { pixText } from "../office/pixfont";
import { STATUS_LABEL, ago, floorAt, floorStatus, stackBuilding, type Floor, type FloorStatus, type Room } from "./model";

type Frame = { x: number; y: number; w: number; h: number };
const F = (propsJson as unknown as { frames: Record<string, Frame> }).frames;
/** in building pixels: the top floor's room inside the roof art, the slab on top of each floor, the shaft */
const ROOF_ROOM_TOP = 74;
const SLAB = 7;
const SHAFT_X = 232;
const ROOM_X0 = 5, ROOM_X1 = 204;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export class BuildingView {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hot: HTMLElement;
  private floors: Floor[] = [];
  private name = "";
  private raf = 0;
  private view = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
  private stack = stackBuilding(1, this.frames());
  private car = { y: -1, target: -1, onArrive: null as null | (() => void) };
  private stars: { x: number; y: number; p: number }[] = [];
  private ro: ResizeObserver;
  private hotKey = "";

  constructor(root: HTMLElement, private img: HTMLImageElement, private onEnter: (room: number) => void) {
    this.el = document.createElement("div");
    this.el.className = "building";
    this.el.hidden = true;
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Building: one floor per Hermes install");
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.hot = document.createElement("div");
    this.hot.className = "building-hot";
    this.el.append(this.canvas, this.hot);
    root.appendChild(this.el);
    this.ctx = this.canvas.getContext("2d")!;
    for (let i = 0; i < 70; i++) this.stars.push({ x: Math.random(), y: Math.random() * 0.7, p: Math.random() * 6 });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  private frames() {
    return { roof: F.b_roof?.h ?? 139, roofRoomTop: ROOF_ROOM_TOP, floors: [F.b_floor0?.h ?? 72, F.b_floor1?.h ?? 72, F.b_floor2?.h ?? 72].filter(Boolean), slab: SLAB, lobby: F.b_lobby?.h ?? 81 };
  }

  show(on: boolean) {
    this.el.hidden = !on;
    cancelAnimationFrame(this.raf);
    if (on) {
      this.resize();
      const loop = (t: number) => { this.raf = requestAnimationFrame(loop); this.draw(t); };
      this.raf = requestAnimationFrame(loop);
    }
  }

  get visible() { return !this.el.hidden; }

  setData(name: string, floors: Floor[]) {
    this.name = name;
    this.floors = floors;
    this.stack = stackBuilding(floors.length, this.frames());
    this.hotKey = "";
    this.resize();
  }

  /** ride the elevator to a room, then call back */
  rideTo(room: number, then: () => void) {
    const r = this.stack.rooms.find((x) => x.floor === room);
    if (!r || this.el.hidden) { then(); return; }
    const target = r.y + r.h - (F.elevator?.h ?? 43);
    if (this.car.y < 0) this.car.y = this.stack.height - (F.b_lobby?.h ?? 81) + 20;
    this.car.target = target;
    this.car.onArrive = then;
  }

  private resize() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    const bw = F.b_roof?.w ?? 277;
    let s = Math.min((H - 40) / this.stack.height, (W * 0.62) / bw);
    if (s > 1) s = Math.floor(s * 2) / 2;
    const ox = Math.round(W * (W < 680 ? 0.56 : 0.55) - (bw * s) / 2);
    const oy = Math.round(H - 14 - this.stack.height * s);
    this.view = { s, ox, oy, w: W, h: H, dpr };
    this.hotKey = "";
  }

  private toScreen(x: number, y: number) { return { x: x * this.view.s + this.view.ox, y: y * this.view.s + this.view.oy }; }

  private draw(t: number) {
    const c = this.ctx;
    const { s, ox, oy, w, h, dpr } = this.view;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // night sky and a street
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#0d0b16");
    g.addColorStop(1, "#1d1622");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (const st of this.stars) {
      c.fillStyle = `rgba(230,220,255,${0.25 + 0.35 * Math.abs(Math.sin(t / 900 + st.p))})`;
      c.fillRect(Math.round(st.x * w), Math.round(st.y * h), 1.5, 1.5);
    }
    c.fillStyle = "#121014";
    c.fillRect(0, oy + this.stack.height * s - 4, w, h);
    c.fillStyle = "#2a2226";
    c.fillRect(0, oy + this.stack.height * s - 4, w, 3);

    c.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    c.imageSmoothingEnabled = false;
    for (const p of this.stack.parts) {
      const f = F[p.frame];
      if (f) c.drawImage(this.img, f.x, f.y, f.w, f.h, 0, p.y, f.w, f.h);
    }
    const now = Date.now();
    for (const r of this.stack.rooms) this.drawRoom(r, floorStatus(floorAt(this.floors, r.floor), now), t);
    this.drawCar(t);
    // name on the roof parapet
    if (this.name) {
      const label = this.name.toUpperCase().slice(0, 22);
      pixText(c, label, 12, 52, 1, "#f2d9a8");
    }
    this.place();
  }

  private drawRoom(r: Room, st: FloorStatus, t: number) {
    const c = this.ctx;
    const shade: Record<FloorStatus, number> = { lit: 0, recent: 0.12, quiet: 0.4, asleep: 0.66, vacant: 0.78, gone: 0.82 };
    const a = shade[st];
    if (st === "lit" || st === "recent") {
      c.save();
      c.globalCompositeOperation = "lighter";
      const k = st === "lit" ? 0.2 + 0.05 * Math.sin(t / 300 + r.floor) : 0.1;
      const gr = c.createRadialGradient(100, r.y + r.h * 0.55, 4, 100, r.y + r.h * 0.55, 120);
      gr.addColorStop(0, `rgba(255,180,90,${k})`);
      gr.addColorStop(1, "rgba(255,150,60,0)");
      c.fillStyle = gr;
      c.fillRect(ROOM_X0, r.y, ROOM_X1 - ROOM_X0, r.h);
      c.restore();
      if (st === "lit") {
        // someone typing: monitors flicker
        c.fillStyle = `rgba(160,220,255,${0.35 + 0.25 * Math.abs(Math.sin(t / 120 + r.floor))})`;
        c.fillRect(58, r.y + r.h - 32, 16, 9);
        c.fillRect(144, r.y + r.h - 32, 14, 9);
      }
    }
    if (a > 0) {
      c.fillStyle = `rgba(8,6,18,${a})`;
      c.fillRect(ROOM_X0, r.y, ROOM_X1 - ROOM_X0, r.h);
    }
    if (st === "asleep") {
      const z = Math.floor(t / 700) % 3;
      for (let i = 0; i <= z; i++) pixText(c, "Z", 120 + i * 6, r.y + 22 - i * 6, 1, "rgba(220,228,255,.85)");
    }
    // floor number plate by the elevator
    pixText(c, String(r.floor), SHAFT_X - 2, r.y + 6, 1, st === "lit" ? "#ffcf7a" : "#bfae96");
  }

  private drawCar(t: number) {
    const f = F.elevator;
    if (!f) return;
    const c = this.ctx;
    if (this.car.y < 0) {
      const top = this.stack.rooms[this.stack.rooms.length - 1];
      this.car.y = this.car.target = top ? top.y + top.h - f.h : 0;
    }
    if (this.car.target >= 0 && Math.abs(this.car.target - this.car.y) > 0.5) {
      const d = this.car.target - this.car.y;
      this.car.y += Math.sign(d) * Math.min(Math.abs(d), 6 + Math.abs(d) * 0.08);
    } else if (this.car.onArrive) {
      const cb = this.car.onArrive;
      this.car.onArrive = null;
      setTimeout(cb, 220);
    }
    c.fillStyle = "#1b120c";
    c.fillRect(SHAFT_X - 0.5, 0, 1, this.car.y + 2);
    c.drawImage(this.img, f.x, f.y, f.w, f.h, Math.round(SHAFT_X - f.w / 2), Math.round(this.car.y), f.w, f.h);
    void t;
  }

  private place() {
    const key = `${this.view.s},${this.view.ox},${this.view.oy},${this.floors.map((f) => `${f.floor}:${f.name}:${f.stats?.lastActivity}:${f.stats?.working}`).join("|")},${Math.floor(Date.now() / 30000)}`;
    if (key === this.hotKey) return;
    this.hotKey = key;
    const now = Date.now();
    let html = this.floors.length ? "" : `<div class="building-empty">No floors yet. Add a Hermes install from the panel.</div>`;
    for (const r of this.stack.rooms) {
      const f = floorAt(this.floors, r.floor);
      const st = floorStatus(f, now);
      const a = this.toScreen(ROOM_X0, r.y), b = this.toScreen(SHAFT_X + 22, r.y + r.h);
      const label = f ? f.name : "Vacant floor";
      const line = f ? `${STATUS_LABEL[st]}${f.stats ? ` · ${ago(f.stats.lastActivity, now)}` : ""}` : "add a Hermes";
      if (f) html += `<button type="button" class="floor-hot" data-floor="${r.floor}" style="left:${Math.round(a.x)}px;top:${Math.round(a.y)}px;width:${Math.round(b.x - a.x)}px;height:${Math.round(b.y - a.y)}px" aria-label="Floor ${r.floor}: ${esc(label)}, ${esc(line)}. Enter the office"></button>`;
      html += `<div class="floor-plate" style="left:${Math.round(a.x) - 10}px;top:${Math.round((a.y + b.y) / 2)}px"><b>${r.floor} · ${esc(label.slice(0, 26))}</b><span class="${st === "lit" ? "live" : ""}">${esc(line)}</span></div>`;
    }
    this.hot.innerHTML = html;
    for (const el of this.hot.querySelectorAll<HTMLElement>(".floor-hot")) el.addEventListener("click", () => this.onEnter(Number(el.dataset.floor)));
  }

  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
}
