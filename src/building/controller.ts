// Many Hermes, one building: the app side. Creates a building (your current office becomes floor 1),
// adds floors for more Hermes installs (each with its own tokens and a one-line installer), shows the
// building cross-section, rides the elevator into a floor's office, and puts an elevator panel in
// every office so you can switch floors. A read-only building link (/building/<id>#v=<token>) lets
// anyone watch every floor.

import { store } from "../engine/storage";
import { BuildingView } from "./view";
import { STATUS_LABEL, ago, demoFloors, floorAt, floorStatus, installLine, normaliseFloors, type Floor } from "./model";

export interface BuildingCreds { id: string; adminToken: string; viewToken: string; origin: string; name: string }
export interface OfficeCredsLike { runId: string; ingestToken: string; viewToken: string; webhookSecret: string; privacy: "metadata" | "args" | "full"; createdAt: number; origin: string }

export interface BuildingHost {
  officeEl: HTMLElement;
  panelAnchor: HTMLElement;
  props: HTMLImageElement;
  /** the office this browser owns (floor 1 of a new building) */
  ownOffice(): OfficeCredsLike | null;
  /** walk into a floor: owner view when we hold its tokens, read-only otherwise */
  enterOffice(floor: Floor, creds: OfficeCredsLike | null, label: string): void;
  /** leave the building surface (back to the normal office) */
  leave(): void;
  toast(msg: string): void;
}

const KEY = "overtime:building:v1";
const OFFICES_KEY = "overtime:building-offices:v1";
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class BuildingController {
  creds: BuildingCreds | null;
  /** /building/<id>#v=… : read-only */
  watch: { id: string; token: string } | null = null;
  floors: Floor[] = [];
  name = "";
  role: "admin" | "view" | null = null;
  /** the floor (room number) whose office is on screen, or 0 when looking at the building */
  current = 0;
  active = false;
  /** the offline sample building (no Worker needed): preview.html and the recorded demo */
  demo = false;
  private demoAt = 0;
  private view: BuildingView;
  private box: HTMLElement;
  private elevator: HTMLElement;
  private poll = 0;
  private error = "";
  private adding: { busy: boolean; created: { floor: number; line: string; name: string } | null } = { busy: false, created: null };

  constructor(private host: BuildingHost) {
    const c = store.getJSON<BuildingCreds | null>(KEY, null);
    this.creds = c && c.origin === location.origin ? c : null;
    this.view = new BuildingView(host.officeEl, host.props, (room) => this.enterRoom(room));
    this.box = document.createElement("div");
    this.box.className = "bx";
    this.box.id = "building-box";
    this.box.hidden = true;
    host.panelAnchor.insertAdjacentElement("afterend", this.box);
    this.elevator = document.createElement("nav");
    this.elevator.className = "elevator";
    this.elevator.setAttribute("aria-label", "Elevator: switch floors");
    this.elevator.hidden = true;
    host.officeEl.appendChild(this.elevator);
  }

  /** /building/<id>#v=<view token> */
  static fromLocation(): { id: string; token: string } | null {
    const m = location.pathname.match(/^\/building\/(bd-[a-z0-9]{8,24})\/?$/);
    if (!m) return null;
    const v = new URLSearchParams(location.hash.slice(1)).get("v");
    return { id: m[1], token: v ?? "" };
  }

  private get id() { return this.watch?.id ?? this.creds?.id ?? ""; }
  private get token() { return this.watch?.token || this.creds?.adminToken || ""; }
  get inBuilding() { return !!this.id || this.demo; }

  /** Opens the offline sample building: floor 1 is the recorded Hermes demo, the others are samples. */
  async openDemo() {
    this.demo = true;
    this.demoAt = Date.now();
    this.name = "Demo building";
    this.role = "view";
    this.error = "";
    await this.open(null);
  }

  private officeCreds(office: string): OfficeCredsLike | null {
    const own = this.host.ownOffice();
    if (own && own.runId === office) return own;
    const map = store.getJSON<Record<string, OfficeCredsLike>>(OFFICES_KEY, {});
    return map[office] && map[office].origin === location.origin ? map[office] : null;
  }

  // ---------- lifecycle ----------
  /** Show the building cross-section. */
  async open(watch?: { id: string; token: string } | null) {
    if (watch) {
      // the admin's own building opened by its link: use the admin token
      this.watch = this.creds && this.creds.id === watch.id ? null : watch;
    }
    this.active = true;
    this.current = 0;
    document.getElementById("app")?.classList.add("is-building");
    this.elevator.hidden = true;
    this.view.show(true);
    this.box.hidden = false;
    await this.refresh();
    clearInterval(this.poll);
    this.poll = window.setInterval(() => { if (this.active || !this.elevator.hidden) void this.refresh(); }, 8000);
  }

  /** Inside an office: hide the building, keep the elevator. */
  private inside(room: number) {
    this.active = false;
    this.current = room;
    document.getElementById("app")?.classList.remove("is-building");
    this.view.show(false);
    this.box.hidden = true;
    this.renderElevator();
  }

  /** Leave the building surface entirely. */
  close() {
    this.active = false;
    this.current = 0;
    clearInterval(this.poll);
    document.getElementById("app")?.classList.remove("is-building");
    this.view.show(false);
    this.box.hidden = true;
    this.elevator.hidden = true;
  }

  async refresh() {
    if (this.demo) {
      // keep the sample's ages steady while you look around
      this.floors = demoFloors(this.demoAt + Math.min(Date.now() - this.demoAt, 60_000));
      this.view.setData(this.name, this.floors);
      this.render();
      if (!this.elevator.hidden) this.renderElevator();
      return;
    }
    if (!this.id) { this.render(); return; }
    try {
      const r = await fetch(`/api/ext/buildings/${encodeURIComponent(this.id)}`, { headers: { authorization: `Bearer ${this.token}` } });
      const j = (await r.json()) as { name?: string; floors?: unknown; role?: "admin" | "view"; error?: string };
      if (!r.ok) {
        this.error = r.status === 401 || r.status === 404 ? "This building link is not valid (or the building was deleted)." : String(j.error ?? r.status);
        if (this.creds && !this.watch && (r.status === 401 || r.status === 404)) { store.setJSON(KEY, null); this.creds = null; }
      } else {
        this.error = "";
        this.name = j.name ?? "Building";
        this.role = j.role ?? null;
        this.floors = normaliseFloors(j.floors);
      }
    } catch (e) {
      this.error = `Could not reach the Overtime Worker (${(e as Error).message}).`;
    }
    this.view.setData(this.name, this.floors);
    this.render();
    if (!this.elevator.hidden) this.renderElevator();
  }

  /** Create a building; the office this browser owns moves in as floor 1. */
  async create(name = "My Hermes building") {
    try {
      const r = await fetch("/api/ext/buildings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const j = (await r.json()) as { buildingId?: string; adminToken?: string; viewToken?: string; error?: string };
      if (!r.ok || !j.buildingId) throw new Error(j.error ?? String(r.status));
      this.creds = { id: j.buildingId, adminToken: j.adminToken!, viewToken: j.viewToken!, origin: location.origin, name };
      store.setJSON(KEY, this.creds);
      this.watch = null;
      const own = this.host.ownOffice();
      if (own) {
        await fetch(`/api/ext/buildings/${j.buildingId}/floors`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.adminToken}` }, body: JSON.stringify({ office: own.runId, ingestToken: own.ingestToken, name: "My Hermes" }) });
      }
      await this.open();
    } catch (e) {
      this.host.toast(`Could not create the building: ${(e as Error).message}`);
    }
  }

  /** A new office for another Hermes install, as the next floor. */
  async addFloor(name: string, privacy: string) {
    if (!this.creds || this.adding.busy) return;
    this.adding = { busy: true, created: null };
    this.render();
    try {
      const r = await fetch(`/api/ext/buildings/${this.creds.id}/floors`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.adminToken}` }, body: JSON.stringify({ create: true, name, privacy }) });
      const j = (await r.json()) as { floor?: number; office?: Record<string, string>; error?: string };
      if (!r.ok || !j.office) throw new Error(j.error ?? String(r.status));
      const o = j.office;
      const creds: OfficeCredsLike = { runId: o.runId, ingestToken: o.ingestToken, viewToken: o.viewToken, webhookSecret: o.webhookSecret, privacy: (o.privacy as OfficeCredsLike["privacy"]) ?? "metadata", createdAt: Date.now(), origin: location.origin };
      const map = store.getJSON<Record<string, OfficeCredsLike>>(OFFICES_KEY, {});
      map[o.runId] = creds;
      store.setJSON(OFFICES_KEY, map);
      await this.refresh();
      const room = this.floors.findIndex((f) => f.office === o.runId) + 1;
      this.adding = { busy: false, created: { floor: room, name, line: installLine(location.origin, o.runId, o.ingestToken, creds.privacy) } };
    } catch (e) {
      this.adding = { busy: false, created: null };
      this.host.toast(`Could not add the floor: ${(e as Error).message}`);
    }
    this.render();
  }

  async removeFloor(room: number) {
    const f = floorAt(this.floors, room);
    if (!f || !this.creds) return;
    await fetch(`/api/ext/buildings/${this.creds.id}/floors/${f.floor}/remove`, { method: "POST", headers: { authorization: `Bearer ${this.creds.adminToken}` } });
    await this.refresh();
  }

  enterRoom(room: number) {
    const f = floorAt(this.floors, room);
    if (!f) return;
    if (this.demo && f.office !== "demo") { this.host.toast("A sample floor. Connect your own Hermes installs to fill a real building."); return; }
    const go = () => {
      this.inside(room);
      this.host.enterOffice(f, this.officeCreds(f.office), `Floor ${room} · ${f.name}`);
    };
    if (this.view.visible) this.view.rideTo(room, go);
    else go();
  }

  backToBuilding() { void this.open(this.watch); }

  viewLink(): string {
    const c = this.creds;
    return c ? `${location.origin}/building/${c.id}#v=${c.viewToken}` : location.href;
  }

  // ---------- panel + elevator ----------
  private renderElevator() {
    const n = this.floors.length;
    if (!n) { this.elevator.hidden = true; return; }
    let html = `<div class="el-ind" aria-live="polite">${this.current || "B"}</div>`;
    for (let k = n; k >= 1; k--) {
      const f = floorAt(this.floors, k)!;
      const st = floorStatus(f, Date.now());
      html += `<button type="button" data-room="${k}" ${k === this.current ? 'aria-current="true"' : ""} aria-label="Floor ${k}: ${esc(f.name)} (${STATUS_LABEL[st]})" title="${esc(f.name)} · ${STATUS_LABEL[st]}">${k}</button>`;
    }
    html += `<button type="button" class="el-lobby" data-room="0" aria-label="Back to the building" title="Building">BLD</button>`;
    this.elevator.innerHTML = html;
    this.elevator.hidden = false;
    for (const b of this.elevator.querySelectorAll<HTMLElement>("button")) b.addEventListener("click", () => {
      const k = Number(b.dataset.room);
      if (k === 0) this.backToBuilding();
      else if (k !== this.current) this.enterRoom(k);
    });
  }

  render() {
    if (this.box.hidden) return;
    const admin = this.role === "admin" && !!this.creds && !this.watch;
    const now = Date.now();
    const rows = this.floors.map((f, i) => {
      const st = floorStatus(f, now);
      return `<li><button type="button" class="bx-floor" data-room="${i + 1}"><span class="n">${i + 1}</span><span class="nm"><b>${esc(f.name)}</b><span>${f.stats ? `${f.stats.sessions} session${f.stats.sessions === 1 ? "" : "s"} · last ${ago(f.stats.lastActivity, now)}${f.stats.latest?.model ? ` · ${esc(f.stats.latest.model)}` : ""}` : "office expired"}</span></span><span class="st ${st === "lit" ? "on" : ""}">${STATUS_LABEL[st]}</span></button></li>`;
    }).reverse().join("");
    const created = this.adding.created;
    this.box.innerHTML = `
      ${this.error ? `<div class="err" role="alert">${esc(this.error)}</div>` : ""}
      <p class="bx-lead"><b>${esc(this.name || "Building")}</b> · ${this.floors.length} floor${this.floors.length === 1 ? "" : "s"}${admin || this.demo ? "" : " · read-only"}. One floor per Hermes install; lit floors are working right now. Click a floor to go in.</p>
      <ol class="bx-floors" aria-label="Floors">${rows || `<li class="lib-empty">No floors yet.</li>`}</ol>
      ${admin ? `
        <details class="bx-add" ${created || this.adding.busy ? "open" : ""}><summary>Add another Hermes</summary>
          <div class="settings" style="padding:12px 0 0">
            <label class="field"><span>Name on the floor plate</span><input data-bx="name" maxlength="60" placeholder="e.g. VPS · cron jobs" /></label>
            <label class="field"><span>What may Overtime see?</span><select data-bx="privacy"><option value="metadata">Metadata (recommended)</option><option value="args">+ tool arguments</option><option value="full">+ messages and output</option></select></label>
            <div class="task-row"><button type="button" class="btn btn-sm btn-primary" data-bx="add" ${this.adding.busy ? "disabled" : ""}>${this.adding.busy ? "Adding…" : "Add a floor"}</button></div>
            ${created ? `<p>Floor ${created.floor} is ready. On that Hermes machine run this once (it installs the plugin and connects it to its own office):</p><div class="hx-snippet"><pre data-bx="line">${esc(created.line)}</pre><button type="button" class="btn btn-sm" data-bx="copy">Copy</button></div>` : ""}
          </div>
        </details>
        <div class="task-row"><button type="button" class="btn btn-sm" data-bx="share">Copy read-only building link</button><span class="spacer"></span><button type="button" class="link-btn" data-bx="leave">Back to my office</button></div>`
      : this.demo ? `<div class="task-row"><span class="task-mode">Sample building · offline demo</span><span class="spacer"></span><button type="button" class="link-btn" data-bx="leave">Back to the demo</button></div>`
      : `<div class="task-row"><span class="task-mode">Read-only building</span></div>`}`;
    for (const b of this.box.querySelectorAll<HTMLElement>("[data-room]")) b.addEventListener("click", () => this.enterRoom(Number(b.dataset.room)));
    this.box.querySelector('[data-bx="add"]')?.addEventListener("click", () => {
      const name = ($<HTMLInputElement>('[data-bx="name"]', this.box)?.value ?? "").trim() || `Hermes ${this.floors.length + 1}`;
      void this.addFloor(name, $<HTMLSelectElement>('[data-bx="privacy"]', this.box)?.value ?? "metadata");
    });
    this.box.querySelector('[data-bx="copy"]')?.addEventListener("click", () => void this.copy(created!.line, "Installer line copied. Run it on that Hermes machine."));
    this.box.querySelector('[data-bx="share"]')?.addEventListener("click", () => void this.copy(this.viewLink(), "Building link copied. Anyone with it can watch every floor, read-only."));
    this.box.querySelector('[data-bx="leave"]')?.addEventListener("click", () => { this.close(); this.host.leave(); });
  }

  private async copy(text: string, ok: string) {
    try { await navigator.clipboard.writeText(text); this.host.toast(ok); } catch { window.prompt("Copy this:", text); }
  }
}
