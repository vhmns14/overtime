// "Watch my Hermes": connects the office to a long-lived external office on the Worker (one per
// Hermes install), replays its history, follows new sessions live over a WebSocket, and plays the
// recorded Hermes demo offline. Drives the same panel pieces as the built-in team.

import { ROLES, ROLE_INFO, type Role, type Ticket } from "../engine/types";
import { store } from "../engine/storage";
import type { Office } from "../office/scene";
import { validateEvent, type ExtEvent } from "../ext/schema";
import { mapHermes, HERMES_OBSERVER_HOOKS, HERMES_WEBHOOK_EVENTS, type Privacy } from "../ext/hermes";
import { applyEvent, latestSession, newOffice, type Effect, type OfficeState, type SessionView } from "../ext/office-state";
import { DEFAULT_RULES, parseRules, type RoleRule } from "../ext/roles";
import { READ_ONLY_APPROVALS, type ApprovalTransport } from "../ext/approvals";
import { hermesDemoScript, stampEnvelope, HERMES_DEMO_TASK } from "../demo/hermes-session";
import { esc } from "./deploy";

export interface OfficeCreds {
  runId: string;
  ingestToken: string;
  viewToken: string;
  webhookSecret: string;
  privacy: Privacy;
  createdAt: number;
  origin: string;
}

export interface HermesHost {
  office: Office;
  speed(): number;
  renderSteps(steps: SessionView["steps"]): void;
  renderLog(log: SessionView["log"], startedAt: number, empty?: string): void;
  renderCost(usd: number, tokens: number, by: Record<Role, { tokens: number; usd: number }> | null, opts?: { meta?: string; names?: Partial<Record<Role, string>>; note?: string }): void;
  setTitle(t: string): void;
  setChip(html: string, status: string): void;
  refreshAgentCard(): void;
  toast(msg: string): void;
  openOverlay(id: "hermes"): void;
  closeOverlay(id: "hermes"): void;
  /** office reactions (lights, sleep, scoreboard, bookshelf): every event of every session, plus a reset after a replay */
  onOffice?(kind: "reset" | "event", st: OfficeState, e?: ExtEvent, effects?: Effect[], live?: boolean): void;
}

type Mode = "connect" | "waiting" | "live" | "demo" | "watch";
const CREDS_KEY = "overtime:hermes-office:v1";
const RULES_KEY = "overtime:hermes-rules:v1";
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export class HermesController {
  mode: Mode = "connect";
  creds: OfficeCreds | null = null;
  st: OfficeState;
  shown: string | null = null;
  follow = true;
  private ws: WebSocket | null = null;
  private wsTries = 0;
  private pollTimer = 0;
  private reconnectTimer = 0;
  private live = false; // false while replaying history: no animations
  private conn: "idle" | "connecting" | "open" | "polling" | "error" = "idle";
  private connError = "";
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private gen = 0;
  private workOff: Partial<Record<Role, number>> = {};
  private demoTimer = 0;
  private demoRunning = false;
  private watch: { id: string; token: string } | null = null;
  private meta: { name?: string; events?: number; sessions?: { id: string }[] } = {};
  private setupTab: "plugin" | "webhook" = "plugin";
  private privacyChoice: Privacy = "metadata";
  approvals: ApprovalTransport = READ_ONLY_APPROVALS;
  rules: RoleRule[];

  constructor(private host: HermesHost) {
    const saved = store.getJSON<RoleRule[] | null>(RULES_KEY, null);
    this.rules = saved && Array.isArray(saved) && saved.length ? saved : DEFAULT_RULES;
    this.st = newOffice(this.rules);
    this.creds = store.getJSON<OfficeCreds | null>(CREDS_KEY, null);
    if (this.creds && this.creds.origin !== location.origin) this.creds = null; // offices belong to one Overtime deployment
  }

  get session(): SessionView | null {
    return this.shown ? this.st.sessions[this.shown] ?? null : null;
  }

  // ---------- lifecycle ----------
  /** Enter the Hermes surface. */
  enter(kind: "hermes" | "demo-hermes" | "watch", watch?: { id: string; token: string }) {
    this.leave();
    this.host.office.reset();
    this.st = newOffice(this.rules);
    this.shown = null;
    this.host.onOffice?.("reset", this.st);
    if (kind === "watch" && watch) {
      this.watch = watch;
      this.mode = "watch";
      void this.connect(watch.id, watch.token);
    } else if (kind === "demo-hermes") {
      this.mode = "demo";
    } else if (this.creds) {
      this.mode = "waiting";
      void this.connect(this.creds.runId, this.creds.viewToken);
    } else this.mode = "connect";
    this.render();
  }

  leave() {
    this.stopDemo();
    this.disconnectStream();
    this.conn = "idle";
  }

  private disconnectStream() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pollTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
  }

  // ---------- connect to an office ----------
  async createOffice() {
    const btn = $<HTMLButtonElement>('[data-hx="create"]');
    if (btn) { btn.disabled = true; btn.textContent = "Creating your office…"; }
    try {
      const r = await fetch("/api/ext/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "hermes", privacy: this.privacyChoice }) });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(j.error ?? r.status));
      this.creds = { runId: String(j.runId), ingestToken: String(j.ingestToken), viewToken: String(j.viewToken), webhookSecret: String(j.webhookSecret), privacy: j.privacy as Privacy, createdAt: Date.now(), origin: location.origin };
      store.setJSON(CREDS_KEY, this.creds);
      this.mode = "waiting";
      this.render();
      this.host.openOverlay("hermes");
      void this.connect(this.creds.runId, this.creds.viewToken);
    } catch (e) {
      this.host.toast(`Could not create the office: ${(e as Error).message}. Is the Overtime Worker running?`);
      if (btn) { btn.disabled = false; btn.textContent = "Connect Hermes"; }
    }
  }

  forget() {
    this.leave();
    store.setJSON(CREDS_KEY, null);
    this.creds = null;
    this.st = newOffice(this.rules);
    this.shown = null;
    this.mode = "connect";
    this.host.office.reset();
    this.host.closeOverlay("hermes");
    this.render();
  }

  private async connect(id: string, token: string) {
    this.disconnectStream();
    this.conn = "connecting";
    this.render();
    try {
      const m = await fetch(`/api/ext/runs/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
      if (m.status === 401 || m.status === 404) {
        this.conn = "error";
        this.connError = this.mode === "watch" ? "This viewer link is not valid (or the office expired)." : "This office no longer exists on the Worker. Create a new one.";
        this.render();
        return;
      }
      this.meta = await m.json();
      const total = Number((this.meta as { events?: number }).events ?? 0);
      const sessions = (this.meta.sessions ?? []) as { id: string }[];
      let events: ExtEvent[] = [];
      if (total) {
        const q = total <= 5000 || !sessions[0] ? "after=0&limit=5000" : `after=0&limit=5000&session=${encodeURIComponent(sessions[0].id)}`;
        const r = await fetch(`/api/ext/runs/${encodeURIComponent(id)}/events?${q}`, { headers: { authorization: `Bearer ${token}` } });
        events = ((await r.json()) as { events: ExtEvent[] }).events ?? [];
      }
      this.live = false;
      for (const e of events) this.ingest(e);
      this.live = true;
      this.host.onOffice?.("reset", this.st);
      if (events.length && this.mode === "waiting") this.mode = "live";
      this.syncScene();
      this.openStream(id, token);
    } catch (e) {
      this.conn = "error";
      this.connError = `Could not reach the Overtime Worker (${(e as Error).message}).`;
      this.render();
      this.reconnectTimer = window.setTimeout(() => void this.connect(id, token), 5000);
    }
  }

  private openStream(id: string, token: string) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/ext/runs/${encodeURIComponent(id)}/stream?v=${encodeURIComponent(token)}&after=${this.st.lastSeq}`);
    } catch {
      this.startPolling(id, token);
      return;
    }
    this.ws = ws;
    ws.onopen = () => { this.conn = "open"; this.wsTries = 0; this.render(); };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data === "pong") return;
      let msg: { type?: string; events?: ExtEvent[] };
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "events" && Array.isArray(msg.events)) {
        for (const e of msg.events) this.ingest(e);
        this.render();
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.mode !== "live" && this.mode !== "waiting" && this.mode !== "watch") return;
      this.wsTries++;
      if (this.wsTries >= 3) { this.startPolling(id, token); return; }
      this.conn = "connecting";
      this.render();
      this.reconnectTimer = window.setTimeout(() => this.openStream(id, token), 1000 * this.wsTries);
    };
  }

  /** Fallback when WebSockets are blocked (corporate proxies): poll the replay endpoint. */
  private startPolling(id: string, token: string) {
    this.conn = "polling";
    this.render();
    clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/ext/runs/${encodeURIComponent(id)}/events?after=${this.st.lastSeq}&limit=1000`, { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const j = (await r.json()) as { events: ExtEvent[] };
        for (const e of j.events ?? []) this.ingest(e);
        if (j.events?.length) this.render();
      } catch { /* keep polling */ }
    }, 2500);
  }

  /** Posts a tiny test session with the office's ingest token, straight from this browser. */
  async sendTest() {
    if (!this.creds) return;
    const sid = `overtime-test-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const batch = [
      { hook_event_name: "on_session_start", session_id: sid, extra: { model: "test", platform: "browser" }, timestamp: now },
      { hook_event_name: "post_tool_call", tool_name: "read_file", tool_input: { path: "README.md" }, session_id: sid, extra: { status: "ok", duration_ms: 42, tool_call_id: "t1" }, timestamp: now },
      { hook_event_name: "on_session_end", session_id: sid, extra: { completed: true }, timestamp: now },
    ];
    const r = await fetch(`/api/ext/runs/${this.creds.runId}/hermes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.ingestToken}` }, body: JSON.stringify({ batch }) });
    this.host.toast(r.ok ? "Test event sent. A test session appears in the office." : `Test failed: HTTP ${r.status}`);
  }

  // ---------- events → state → scene ----------
  ingest(e: ExtEvent) {
    if (e.seq && e.seq <= this.st.lastSeq) return;
    const { session, effects } = applyEvent(this.st, e);
    this.host.onOffice?.("event", this.st, e, effects, this.live);
    if (this.mode === "waiting" && this.live) { this.mode = "live"; this.host.closeOverlay("hermes"); }
    const newSession = effects.some((f) => f.k === "session");
    if (!this.shown || !this.st.sessions[this.shown] || (this.follow && newSession && session !== this.shown)) {
      const switching = this.shown !== session;
      this.shown = session;
      if (switching && this.live) this.syncScene();
    }
    if (session === this.shown && this.live) for (const f of effects) this.effect(f);
  }

  /** Re-draws the office from the shown session's state (after replay or a session switch). */
  syncScene() {
    this.gen++;
    const o = this.host.office;
    o.reset();
    const s = this.session;
    if (!s) { this.render(); return; }
    o.setTickets(s.tickets);
    for (const sa of Object.values(s.subagents)) if (sa.status === "running") o.setTag(sa.desk, s.agents[sa.desk].name);
    const working = new Set(Object.values(s.openTools).map((t) => t.role));
    for (const r of working) o.setWorking(r, true);
    if (s.pending) o.setWaiting(s.pending.role, s.pending.kind === "approval" ? "Waiting for approval in Hermes" : "Waiting for you in Hermes");
    this.render();
  }

  private anim(fn: () => Promise<void>, droppable = true) {
    if (droppable && this.queued >= 2) return; // stay live: skip walks when events outrun the animation
    this.queued++;
    const gen = this.gen;
    // a walk that was queued before the turn ended (or the session switched) is stale: skip it
    this.queue = this.queue.then(() => (gen === this.gen ? fn() : undefined)).catch(() => undefined).finally(() => { this.queued--; });
  }

  private effect(f: Effect) {
    const o = this.host.office;
    const offLater = (r: Role, ms: number) => {
      clearTimeout(this.workOff[r]);
      this.workOff[r] = window.setTimeout(() => {
        const s = this.session;
        if (!s || !Object.values(s.openTools).some((t) => t.role === r)) o.setWorking(r, false);
      }, ms * Math.max(0.3, this.host.speed()));
    };
    switch (f.k) {
      case "work":
        if (f.on) { clearTimeout(this.workOff[f.role]); o.setWorking(f.role, true); if (f.say) o.say(f.role, f.say, "think", 2400); }
        else offLater(f.role, 1400);
        break;
      case "pulse":
        clearTimeout(this.workOff[f.role]);
        o.setWorking(f.role, true);
        if (f.say) o.say(f.role, f.say, "think", 2200);
        offLater(f.role, 1600);
        break;
      case "say": o.say(f.role, f.text, f.kind ?? "think", 3000); break;
      case "handoff": this.anim(() => o.meeting(f.from, f.to, f.text)); break;
      case "whiteboard": { const t: Ticket[] = f.tickets; this.anim(() => o.whiteboard(t)); break; }
      case "tickets": o.setTickets(f.tickets); break;
      case "wait": o.setWaiting(f.role, f.text); break;
      case "clear-wait": o.clearWaiting(); break;
      case "tag": o.setTag(f.role, f.text); break;
      case "idle-all": this.gen++; for (const r of ROLES) { clearTimeout(this.workOff[r]); o.setWorking(r, false); } break;
      case "session": break;
    }
  }

  // ---------- recorded demo ----------
  playDemo() {
    this.stopDemo();
    this.mode = "demo";
    this.host.office.reset();
    this.st = newOffice(this.rules);
    this.shown = null;
    this.live = true;
    this.host.onOffice?.("reset", this.st);
    this.demoRunning = true;
    const script = hermesDemoScript();
    let i = 0;
    let seq = 0;
    let clock = Date.now();
    const next = () => {
      if (i >= script.length) { this.demoRunning = false; this.render(); return; }
      const [delay, env] = script[i];
      const n = i++;
      this.demoTimer = window.setTimeout(() => {
        clock += delay;
        for (const raw of mapHermes(stampEnvelope(env, clock, n), "full")) {
          const v = validateEvent(raw, clock);
          if (v.ok) this.ingest({ ...v.event, seq: ++seq } as ExtEvent);
        }
        this.render();
        next();
      }, delay * this.host.speed());
    };
    this.render();
    next();
  }

  stopDemo() {
    clearTimeout(this.demoTimer);
    this.demoRunning = false;
  }

  get demoActive() { return this.demoRunning; }

  // ---------- panel ----------
  private statusLine(): { html: string; status: string } {
    const s = this.session;
    if (this.mode === "demo") return { html: `<b>Demo</b> · recorded Hermes session · ${this.demoRunning ? (s?.status === "waiting" ? "waiting for approval" : "working") : s ? "done" : "ready"}`, status: this.demoRunning ? (s?.status === "waiting" ? "waiting" : "running") : s ? "done" : "idle" };
    const connTxt = { idle: "offline", connecting: "connecting…", open: "live", polling: "live (polling)", error: "offline" }[this.conn];
    const who = this.mode === "watch" ? "<b>Read-only</b> · " : "<b>Hermes</b> · ";
    if (!s) return { html: `${who}${this.mode === "connect" ? "not connected" : connTxt} · waiting for the first event`, status: this.conn === "error" ? "failed" : "idle" };
    const st = { working: "working", idle: "idle", waiting: "waiting in Hermes", ended: "session closed" }[s.status];
    return { html: `${who}${esc(s.model ?? "")} · ${st} · ${connTxt}`, status: s.status === "working" ? "running" : s.status === "waiting" ? "waiting" : this.conn === "error" ? "failed" : "idle" };
  }

  render() {
    const box = $("#hermes-box");
    if (!box) return;
    const s = this.session;
    const chip = this.statusLine();
    this.host.setChip(chip.html, chip.status);
    this.host.setTitle(s ? s.title : this.mode === "demo" ? HERMES_DEMO_TASK : "Watch your Hermes agent");
    const sessions = this.st.order.map((id) => this.st.sessions[id]).sort((a, b) => b.lastAt - a.lastAt);
    let html = "";
    if (this.mode === "connect") {
      html = `<p class="hx-lead">See your own <b>Hermes Agent</b> work in this office: every tool call, subagent, approval and dollar, live. Hermes keeps running on your server; Overtime only receives events.</p>
        <label class="field"><span>What may Overtime see?</span><select data-hx="privacy">
          <option value="metadata" ${this.privacyChoice === "metadata" ? "selected" : ""}>Metadata: tool names, paths, command names, tokens, cost (recommended)</option>
          <option value="args" ${this.privacyChoice === "args" ? "selected" : ""}>+ tool arguments and full commands (truncated)</option>
          <option value="full" ${this.privacyChoice === "full" ? "selected" : ""}>+ your messages and tool output (truncated)</option></select>
          <small>Secrets that look like keys or tokens are redacted on your server and again here.</small></label>
        <div class="task-row"><button type="button" class="btn btn-primary" data-hx="create">Connect Hermes</button><button type="button" class="btn" data-hx="demo">Watch a recorded session</button></div>`;
    } else if (this.mode === "demo") {
      html = `<p class="hx-lead">A real Hermes session, replayed: plan on the whiteboard, a subagent at a borrowed desk, a failing test fixed, and an approval Hermes asked for in its own CLI.</p>
        <div class="task-row"><button type="button" class="btn btn-primary" data-hx="play">${this.demoRunning ? "Restart demo" : s ? "Play again" : "Play demo"}</button>${this.creds ? `<button type="button" class="btn" data-hx="mine">Back to my Hermes</button>` : `<button type="button" class="btn" data-hx="connect">Connect my Hermes</button>`}</div>`;
    } else {
      const err = this.conn === "error" ? `<div class="err" role="alert">${esc(this.connError)}</div>` : "";
      const picker = sessions.length > 1 || (sessions.length === 1 && this.mode !== "waiting")
        ? `<label class="hx-sessions"><span class="sr-only">Session</span><select data-hx="session">${sessions.map((x) => `<option value="${esc(x.id)}" ${x.id === this.shown ? "selected" : ""}>${esc(shortTitle(x))}</option>`).join("")}</select></label>
           <label class="check hx-follow"><input type="checkbox" data-hx="follow" ${this.follow ? "checked" : ""}> Follow new sessions</label>` : "";
      const waiting = !s ? `<div class="hx-wait" role="status"><span class="hx-pulse" aria-hidden="true"></span><div><b>Waiting for the first event…</b><br><span>Run any task in Hermes. New sessions show up here by themselves.</span></div></div>` : "";
      const actions = this.mode === "watch"
        ? `<span class="task-mode">Read-only viewer</span>`
        : `<button type="button" class="btn btn-sm" data-hx="setup">Setup</button><button type="button" class="btn btn-sm" data-hx="share">Copy viewer link</button><span class="spacer"></span><button type="button" class="link-btn" data-hx="demo">Demo</button>`;
      html = `${err}${waiting}${picker ? `<div class="hx-row">${picker}</div>` : ""}<div class="task-row">${actions}</div>`;
    }
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      this.bindBox(box);
    }
    // shared panel pieces
    if (s) {
      this.host.renderSteps(s.steps);
      this.host.renderLog(s.log, s.startedAt);
      const names = Object.fromEntries(ROLES.filter((r) => s.agents[r].name !== ROLE_INFO[r].name).map((r) => [r, s.agents[r].name]));
      this.host.renderCost(s.cost.usd, s.cost.tokens, s.cost.byAgent, {
        meta: `${s.cost.tokens >= 1000 ? `${(s.cost.tokens / 1000).toFixed(1)}k` : s.cost.tokens} tokens · ${s.cost.calls} model call${s.cost.calls === 1 ? "" : "s"}${this.mode === "demo" ? " · demo" : ""}`,
        names,
        note: s.cost.unpriced.length ? `No price known for ${s.cost.unpriced.join(", ")}: tokens only.` : this.mode === "demo" ? "Demo spend uses list prices for Claude Sonnet 4." : "Cost comes from Hermes' own estimate when it knows the model's price.",
      });
    } else {
      this.host.renderSteps(Object.fromEntries(["plan", "research", "code", "review", "deploy"].map((k) => [k, { state: "pending" }])) as SessionView["steps"]);
      this.host.renderLog([], Date.now(), this.mode === "demo" ? "Press <b>Play demo</b> to replay a real Hermes session in the office." : this.mode === "connect" ? "Connect Hermes and its sessions play out here: research at the Research desk, edits at the Coder's, tests with the Reviewer, deploys with Ops, plans on the whiteboard." : "Nothing yet. Events from Hermes appear here the moment it starts working.");
      this.host.renderCost(0, 0, null, { meta: "0 tokens", note: "Cost comes from Hermes' own estimate when it knows the model's price." });
    }
    this.renderPending();
    this.host.refreshAgentCard();
    if (!$("#hermes").hidden) this.renderSetup();
  }

  /** Read-only approval card: Hermes asks in its own UI; v1 never answers remotely (see ApprovalTransport). */
  private renderPending() {
    const card = $("#approval");
    const p = this.session?.pending;
    if (!p) { if (card.dataset.ext) { card.hidden = true; delete card.dataset.ext; } return; }
    const where = this.session?.platform ? ` (${esc(this.session.platform)})` : "";
    const html = `<p class="approval-title"><b>Hermes is waiting for ${p.kind === "approval" ? "approval" : "you"}</b> in its own UI${where}.</p>
      <p class="hx-pending">${esc(p.text)}</p>${p.detail ? `<pre class="diff"><span>${esc(p.detail)}</span></pre>` : ""}
      <p class="cost-meta">${this.approvals.canRespond() ? "" : "Answer it where you run Hermes. Overtime only watches, it never approves."}</p>`;
    if (card.innerHTML !== html) card.innerHTML = html;
    card.dataset.ext = "1";
    card.hidden = false;
  }

  private bindBox(box: HTMLElement) {
    box.querySelector('[data-hx="create"]')?.addEventListener("click", () => void this.createOffice());
    box.querySelector('[data-hx="demo"]')?.addEventListener("click", () => { document.dispatchEvent(new CustomEvent("overtime:surface", { detail: "demo-hermes" })); });
    box.querySelector('[data-hx="play"]')?.addEventListener("click", () => this.playDemo());
    box.querySelector('[data-hx="mine"]')?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("overtime:surface", { detail: "hermes" })));
    box.querySelector('[data-hx="connect"]')?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("overtime:surface", { detail: "hermes" })));
    box.querySelector('[data-hx="setup"]')?.addEventListener("click", () => this.host.openOverlay("hermes"));
    box.querySelector('[data-hx="share"]')?.addEventListener("click", () => void this.copy(this.watchUrl(), "Viewer link copied. Anyone with it can watch, read-only."));
    box.querySelector<HTMLSelectElement>('[data-hx="privacy"]')?.addEventListener("change", (e) => { this.privacyChoice = (e.target as HTMLSelectElement).value as Privacy; });
    box.querySelector<HTMLSelectElement>('[data-hx="session"]')?.addEventListener("change", (e) => {
      this.shown = (e.target as HTMLSelectElement).value;
      this.follow = this.shown === latestSession(this.st);
      this.syncScene();
    });
    box.querySelector<HTMLInputElement>('[data-hx="follow"]')?.addEventListener("change", (e) => {
      this.follow = (e.target as HTMLInputElement).checked;
      if (this.follow) { const l = latestSession(this.st); if (l && l !== this.shown) { this.shown = l; this.syncScene(); } }
    });
  }

  watchUrl(): string {
    const c = this.creds;
    return c ? `${location.origin}/watch/${c.runId}#v=${c.viewToken}` : location.href;
  }

  private async copy(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.host.toast(ok);
    } catch {
      window.prompt("Copy this:", text);
    }
  }

  // ---------- setup overlay ----------
  snippets() {
    const c = this.creds!;
    const origin = location.origin;
    const ingest = `${origin}/api/ext/runs/${c.runId}/hermes`;
    const plugin = [
      "# 1. Install the plugin (observer hooks only, one Python file, no dependencies)",
      "mkdir -p ~/.hermes/plugins/hermes-overtime",
      `curl -fsSL ${origin}/hermes-overtime/plugin.yaml -o ~/.hermes/plugins/hermes-overtime/plugin.yaml`,
      `curl -fsSL ${origin}/hermes-overtime/__init__.py -o ~/.hermes/plugins/hermes-overtime/__init__.py`,
      "hermes plugins enable hermes-overtime",
      "",
      "# 2. Point it at this office",
      "cat >> ~/.hermes/.env <<'EOF'",
      `OVERTIME_URL=${ingest}`,
      `OVERTIME_TOKEN=${c.ingestToken}`,
      `OVERTIME_PRIVACY=${c.privacy}`,
      "EOF",
      "",
      "# 3. Restart Hermes (a new `hermes` session, or restart the gateway), then:",
      "hermes overtime test     # sends a test session",
      "# inside a session, /overtime prints this office's viewer link",
    ].join("\n");
    const webhook = [
      "# ~/.hermes/config.yaml  (Hermes builds with outbound webhooks: hooks.outbound)",
      "hooks:",
      "  outbound:",
      "    - name: overtime",
      `      url: ${origin}/api/ext/hermes/webhook/${c.runId}`,
      `      events: [${HERMES_WEBHOOK_EVENTS.join(", ")}]`,
      "      secret_env: OVERTIME_WEBHOOK_SECRET",
      "      timeout: 5",
      "",
      "# ~/.hermes/.env",
      `OVERTIME_WEBHOOK_SECRET=${c.webhookSecret}`,
    ].join("\n");
    return { plugin, webhook, ingest };
  }

  renderSetup() {
    const el = $("#hermes");
    if (!this.creds) {
      el.innerHTML = `<div class="ov-head"><h2>Connect Hermes</h2><span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div><div class="settings"><p>Create an office first.</p></div>`;
      el.querySelector("[data-close]")!.addEventListener("click", () => this.host.closeOverlay("hermes"));
      return;
    }
    const sn = this.snippets();
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
    const tab = this.setupTab;
    const s = this.session;
    el.innerHTML = `<div class="ov-head"><h2>Connect Hermes</h2><span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div>
      <div class="settings hx-setup">
        <p>This is your office: it stays up and picks up every new Hermes session on its own (it is deleted after 30 days without events). Keep the token private; the viewer link is read-only.</p>
        ${local ? `<div class="err" role="note">Overtime runs on <code>${esc(location.host)}</code>. Hermes must be able to reach that address: fine when Hermes runs on this machine; for a remote server deploy Overtime (<code>npm run deploy</code>) or use a tunnel.</div>` : ""}
        <div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="plugin" aria-selected="${tab === "plugin"}">Plugin (recommended)</button><button class="tab" role="tab" data-tab="webhook" aria-selected="${tab === "webhook"}">Webhooks (no code)</button></div>
        ${tab === "plugin"
          ? `<p>Batched, off the agent thread, drops events instead of slowing Hermes down. Works on Hermes 0.19+. Hooks: ${HERMES_OBSERVER_HOOKS.length} observers, nothing that can change what Hermes does.</p>`
          : `<p>Zero code: Hermes POSTs each hook to Overtime, signed with HMAC-SHA256 (<code>X-Hermes-Signature-256</code>). Needs a Hermes build with <code>hooks.outbound</code> (newer than 0.19.0 on PyPI). Uses the office's privacy level (<b>${esc(this.creds.privacy)}</b>) on arrival.</p>`}
        <div class="hx-snippet"><pre data-snippet>${esc(tab === "plugin" ? sn.plugin : sn.webhook)}</pre><button type="button" class="btn btn-sm" data-copy>Copy</button></div>
        <div class="hx-wait" role="status">${s ? `<span class="hx-dot ok" aria-hidden="true"></span><div><b>Connected.</b> ${this.st.order.length} session${this.st.order.length === 1 ? "" : "s"} so far.</div>` : `<span class="hx-pulse" aria-hidden="true"></span><div><b>Waiting for the first event…</b><br><span>Run any task in Hermes once the plugin is in.</span></div>`}</div>
        <div class="task-row"><button type="button" class="btn btn-sm" data-test>Send a test event</button><button type="button" class="btn btn-sm" data-watch>Copy viewer link</button></div>
        <details><summary>Advanced: who shows what (role rules)</summary>
          <p>First match wins. <code>types</code> are event types, <code>tool</code> and <code>target</code> are regexes on the tool name and its target (path, URL host or command name).</p>
          <textarea class="hx-rules" spellcheck="false" aria-label="Role rules JSON">${esc(JSON.stringify(this.rules, null, 1))}</textarea>
          <div class="task-row"><button type="button" class="btn btn-sm" data-rules-save>Save rules</button><button type="button" class="link-btn" data-rules-reset>Reset to defaults</button><span class="cost-meta" data-rules-msg></span></div>
        </details>
        <details><summary>Other agents (generic events API)</summary>
          <p>Anything can drive this office: <code>POST ${esc(location.origin)}/api/ext/runs/${esc(this.creds.runId)}/events</code> with <code>Authorization: Bearer &lt;token&gt;</code> and events like <code>{"type":"tool.start","session":"s1","data":{"name":"web_search"}}</code>. The schema is in docs/EVENTS.md.</p>
        </details>
        <div class="task-row"><span class="spacer"></span><button type="button" class="link-btn" data-forget>Forget this office on this device</button></div>
      </div>`;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.host.closeOverlay("hermes"));
    el.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => { this.setupTab = b.dataset.tab as "plugin" | "webhook"; this.renderSetup(); }));
    el.querySelector("[data-copy]")!.addEventListener("click", () => void this.copy(tab === "plugin" ? sn.plugin : sn.webhook, "Setup copied. Paste it on your Hermes server."));
    el.querySelector("[data-test]")!.addEventListener("click", () => void this.sendTest());
    el.querySelector("[data-watch]")!.addEventListener("click", () => void this.copy(this.watchUrl(), "Viewer link copied."));
    el.querySelector("[data-forget]")!.addEventListener("click", () => { if (confirm("Forget this office on this device? Hermes keeps sending to it until you remove the plugin settings.")) this.forget(); });
    el.querySelector("[data-rules-save]")!.addEventListener("click", () => {
      const r = parseRules(el.querySelector<HTMLTextAreaElement>(".hx-rules")!.value);
      const msg = el.querySelector<HTMLElement>("[data-rules-msg]")!;
      if ("error" in r) { msg.textContent = r.error; return; }
      this.setRules(r.rules);
      msg.textContent = "Saved. New events use these rules.";
    });
    el.querySelector("[data-rules-reset]")!.addEventListener("click", () => { this.setRules(DEFAULT_RULES); this.renderSetup(); });
  }

  private setRules(rules: RoleRule[]) {
    this.rules = rules;
    this.st.rules = rules;
    store.setJSON(RULES_KEY, rules === DEFAULT_RULES ? null : rules);
  }
}

function shortTitle(s: SessionView): string {
  const t = new Date(s.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${s.title.length > 34 ? s.title.slice(0, 33) + "…" : s.title} · ${t}`;
}
