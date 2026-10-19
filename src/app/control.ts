// Remote control in the Hermes office (opt-in): Approve/Deny Hermes' gateway approvals, send tasks to
// Hermes, notifications (Telegram, Web Push), paired devices and the signed audit log.
// Talks to /api/ext/runs/<office>/control/* with a per-device control token (never the view token).

import "./control.css";
import { store } from "../engine/storage";
import {
  describeAudit, verifyAudit,
  type ApprovalView, type AuditEntry, type CommandView, type DeviceView, type RemoteChoice,
} from "../ext/control";
import { TRIGGERS, type NotifySettings, type Trigger } from "../ext/notify";
import type { ApprovalTransport } from "../ext/approvals";

export interface ControlOffice { id: string; viewToken: string; ingestToken?: string }

export interface ControlHost {
  toast(msg: string): void;
  /** the session the office currently shows */
  shownSession(): string | null;
  /** re-render the Hermes panel (the read-only approval card hides when a remote one covers it) */
  changed(): void;
}

interface Creds { token: string; deviceId: string; deviceName: string }

interface State {
  office: string;
  policy: { remoteApproval: boolean; remoteTasks: boolean };
  notify: NotifySettings;
  telegram: { set: boolean; chatId?: string; tokenTail?: string; server?: boolean; serverAvailable?: boolean };
  push: { vapidPublicKey: string; subscriptions: number; mine: string[] };
  devices: DeviceView[];
  approvals: ApprovalView[];
  commands: CommandView[];
  sent: { k: string; channel: string; at: number; trig: string; result: string }[];
}

const KEY = (office: string) => `overtime:control:v1:${office}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? hhmm(t) : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hhmm(t)}`;
};
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function defaultDeviceName(ua = navigator.userAgent): string {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${br}`;
}

const CHOICE_TXT: Record<RemoteChoice, string> = { once: "Approved once", session: "Approved for this session", deny: "Denied" };
const CMD_TXT: Record<CommandView["status"], string> = { queued: "waiting for Hermes", claimed: "picked up", started: "running", completed: "done", failed: "failed", cancelled: "cancelled", rejected: "refused by Hermes", lost: "lost" };

export class ControlController {
  office: ControlOffice | null = null;
  creds: Creds | null = null;
  state: State | null = null;
  private err = "";
  private pollTimer = 0;
  private tickTimer = 0;
  private fetching: Promise<void> | null = null;
  private again = false;
  private draft = "";
  private confirming = false;
  private pairLink = "";
  private audit: { entries: AuditEntry[]; ok: boolean; error?: string } | null = null;
  private busy = new Set<string>();
  private dismissed = new Set<string>();

  constructor(private host: ControlHost) {}

  // ---------- lifecycle ----------
  /** Attach to an office (owner tab or a /watch tab). A control token in the URL fragment (c=) pairs this device. */
  attach(office: ControlOffice | null) {
    this.detach();
    this.office = office;
    this.state = null;
    this.err = "";
    if (!office) { this.renderAll(); return; }
    const h = new URLSearchParams(location.hash.slice(1));
    const c = h.get("c");
    const p = h.get("p");
    if (c || p) {
      // the secret leaves the address bar (and history) before anything else happens
      h.delete("c");
      h.delete("p");
      history.replaceState(null, "", `${location.pathname}${location.search}#${h.toString()}`);
    }
    if (c && /^ot_ctl_[\w-]{16,}$/.test(c)) {
      // links made before one-time pairing carried a device token directly
      this.save({ token: c, deviceId: "", deviceName: "" });
      this.host.toast("This device can now answer Hermes' approvals and send tasks.");
    }
    this.creds = store.getJSON<Creds | null>(KEY(office.id), null);
    if (p && /^ot_pair_[\w-]{16,}$/.test(p)) { void this.claim(p); this.renderAll(); return; }
    void this.refresh();
    this.renderAll();
  }

  /** Swaps a one-time pairing code (from a pairing link) for this device's own control token. */
  private async claim(code: string) {
    type Claimed = { controlToken?: string; deviceId?: string; deviceName?: string; error?: string };
    const r: { status: number; json: Claimed } = await this.api<Claimed>("POST", "devices/claim", { code }, "").catch(() => ({ status: 0, json: { error: "network error" } }));
    if (r.status === 201 && r.json.controlToken) {
      this.save({ token: r.json.controlToken, deviceId: String(r.json.deviceId ?? ""), deviceName: String(r.json.deviceName ?? "") });
      this.host.toast("This device can now answer Hermes' approvals and send tasks.");
    } else this.host.toast(r.json?.error ?? `Pairing failed (HTTP ${r.status}).`);
    await this.refresh();
  }

  detach() {
    clearInterval(this.pollTimer);
    clearInterval(this.tickTimer);
    this.office = null;
    this.state = null;
    this.renderAll();
  }

  private save(c: Creds | null) {
    if (!this.office) return;
    store.setJSON(KEY(this.office.id), c);
    this.creds = c;
  }

  get paired() { return !!this.creds && !!this.office; }

  /** Insights' budgets → the office's server-side budget notifications (only on a paired device). */
  async syncBudget(b: { dailyUsd: number | null; monthlyUsd: number | null }): Promise<boolean> {
    if (!this.paired) return false;
    const r = await this.api("POST", "notify", { settings: { budget: { dailyUsd: b.dailyUsd, monthlyUsd: b.monthlyUsd } } }).catch(() => ({ status: 0 }));
    return r.status === 200;
  }
  get canEnable() { return !!this.office?.ingestToken && !this.paired; }

  /** A content-free ping from the office stream: something changed. */
  onPing() { if (this.paired) void this.refresh(); }

  // ---------- network ----------
  private async api<T = any>(method: "GET" | "POST", path: string, body?: unknown, token = this.creds?.token): Promise<{ status: number; json: T }> {
    const r = await fetch(`/api/ext/runs/${encodeURIComponent(this.office!.id)}/control/${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, json };
  }

  async refresh(): Promise<void> {
    if (!this.paired) { this.renderAll(); return; }
    if (this.fetching) { this.again = true; return this.fetching; }
    this.fetching = (async () => {
      try {
        const r = await this.api<State>("GET", "state");
        if (r.status === 401) {
          this.save(null);
          this.state = null;
          this.err = "This device was removed from remote control.";
        } else if (r.status === 200) {
          this.state = r.json;
          this.err = "";
          const me = r.json.devices.find((d) => d.current);
          if (me && this.creds && (this.creds.deviceId !== me.id || this.creds.deviceName !== me.name)) this.save({ ...this.creds, deviceId: me.id, deviceName: me.name });
        }
      } catch {
        this.err = "Could not reach Overtime.";
      } finally {
        this.fetching = null;
      }
      this.schedule();
      this.renderAll();
      // a change arrived while this request was in flight: fetch once more
      if (this.again) { this.again = false; await this.refresh(); }
    })();
    return this.fetching;
  }

  private schedule() {
    clearInterval(this.pollTimer);
    clearInterval(this.tickTimer);
    const s = this.state;
    if (!s) return;
    const live = s.approvals.some((a) => a.status === "pending" || a.status === "decided") || s.commands.some((c) => ["queued", "claimed", "started"].includes(c.status));
    // the stream pings on every change; this is only a safety net (e.g. WebSockets blocked)
    if (live) this.pollTimer = window.setInterval(() => void this.refresh(), 15_000);
    if (s.approvals.some((a) => a.status === "pending")) this.tickTimer = window.setInterval(() => this.renderCard(), 1000);
  }

  // ---------- approvals ----------
  pendingApprovals(): ApprovalView[] {
    if (!this.state?.policy.remoteApproval) return [];
    const now = Date.now();
    return this.state.approvals.filter((a) => a.status === "pending" && a.expiresAt > now);
  }

  /** True when a remote approval card covers the pending approval of this session. */
  covers(session: string | null): boolean {
    return this.pendingApprovals().some((a) => !session || a.session === session) || this.recentlyDecided().some((a) => !session || a.session === session);
  }

  private recentlyDecided(): ApprovalView[] {
    const now = Date.now();
    return (this.state?.approvals ?? []).filter((a) => a.decidedAt && now - a.decidedAt < 90_000 && !this.dismissed.has(a.id));
  }

  readonly transport: ApprovalTransport = {
    name: "overtime-remote",
    canRespond: () => this.pendingApprovals().length > 0,
    respond: async (requestId, choice) => {
      if (choice === "always") return { ok: false, error: "\"Always\" can only be chosen in Hermes itself." };
      return this.decide(requestId, choice);
    },
  };

  async decide(id: string, choice: RemoteChoice): Promise<{ ok: boolean; error?: string }> {
    if (this.busy.has(id)) return { ok: false, error: "busy" };
    this.busy.add(id);
    this.renderCard();
    try {
      const r = await this.api("POST", `approvals/${encodeURIComponent(id)}/decide`, { choice });
      if (r.status !== 200) {
        const msg = r.json?.error ?? `HTTP ${r.status}`;
        this.host.toast(`Could not answer: ${msg}`);
        return { ok: false, error: msg };
      }
      this.host.toast(`${CHOICE_TXT[choice]}. Sent to Hermes.`);
      return { ok: true };
    } finally {
      this.busy.delete(id);
      await this.refresh();
    }
  }

  // ---------- rendering ----------
  renderAll() {
    this.renderCard();
    this.renderTasks();
    if (!document.querySelector<HTMLElement>("#control")?.hidden) this.renderOverlay();
    this.host.changed();
  }

  private ensure(id: string, after: string, cls: string): HTMLElement | null {
    let el = document.getElementById(id);
    if (!el) {
      const anchor = document.querySelector(after);
      if (!anchor) return null;
      el = document.createElement("div");
      el.id = id;
      el.className = cls;
      anchor.insertAdjacentElement("afterend", el);
    }
    return el;
  }

  /** The approval card: desktop panel and a bottom sheet on phones. */
  renderCard() {
    const el = this.ensure("ctl-approval", "#approval", "ctl-approval");
    if (!el) return;
    const pend = this.pendingApprovals();
    const done = this.recentlyDecided().filter((a) => !pend.includes(a));
    if (!this.paired || (!pend.length && !done.length)) { el.hidden = true; el.innerHTML = ""; return; }
    const shown = this.host.shownSession();
    const now = Date.now();
    const items = pend.map((a) => {
      const busy = this.busy.has(a.id);
      const other = shown && a.session !== shown ? `<span class="ctl-tag">another session</span>` : "";
      return `<div class="ctl-item" data-id="${esc(a.id)}">
        <p class="approval-title"><b>Hermes asks for approval</b> ${other}</p>
        <p class="hx-pending">${esc(a.description || "A command needs approval")}</p>
        <pre class="diff"><span>${esc(a.command)}</span></pre>
        ${a.truncated ? `<p class="err ctl-warn" role="alert">This command is too long to show in full. Approve it in Hermes itself; here you can only deny it.</p>` : ""}
        ${a.redacted ? `<p class="cost-meta ctl-warn">Parts that look like secrets are hidden as [redacted]. If you are unsure what they are, answer in Hermes.</p>` : ""}
        <div class="actions ctl-actions">
          <button type="button" class="btn btn-primary" data-ctl="once" ${busy || a.truncated ? "disabled" : ""}>Approve once</button>
          <button type="button" class="btn" data-ctl="deny" ${busy ? "disabled" : ""}>Deny</button>
        </div>
        <div class="ctl-more"><button type="button" class="link-btn" data-ctl="session" ${busy || a.truncated ? "disabled" : ""}>Approve for the rest of this session</button>
        <span class="cost-meta" data-countdown>Hermes keeps asking in its own UI too · first answer wins · falls back in ${mmss(a.expiresAt - now)}</span></div>
      </div>`;
    }).join("");
    const history = done.map((a) => {
      const res = a.status === "applied" ? "Hermes applied it" : a.status === "decided" ? "sending to Hermes…" : a.status === "stale" ? "too late: it was already answered in Hermes" : a.status === "answered_locally" ? "answered in Hermes itself" : a.status;
      return `<div class="ctl-done" data-id="${esc(a.id)}"><span class="ctl-dot ${a.choice === "deny" ? "deny" : a.status === "stale" ? "warn" : "ok"}" aria-hidden="true"></span>
        <div><b>${esc(a.choice ? CHOICE_TXT[a.choice] : "Answered")}</b> by ${esc(a.by ?? "?")} at ${esc(a.decidedAt ? hhmm(a.decidedAt) : "")}<br><span>${esc(a.description || a.command)} · ${esc(res)}</span></div>
        <button type="button" class="link-btn" data-dismiss aria-label="Dismiss">Dismiss</button></div>`;
    }).join("");
    const html = items + history;
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
      el.querySelectorAll<HTMLElement>("[data-ctl]").forEach((b) => b.addEventListener("click", () => {
        const id = b.closest<HTMLElement>("[data-id]")!.dataset.id!;
        void this.decide(id, b.dataset.ctl as RemoteChoice);
      }));
      el.querySelectorAll<HTMLElement>("[data-dismiss]").forEach((b) => b.addEventListener("click", () => { this.dismissed.add(b.closest<HTMLElement>("[data-id]")!.dataset.id!); this.renderAll(); }));
    } else {
      // only the countdown moves
      el.querySelectorAll<HTMLElement>(".ctl-item").forEach((it) => {
        const a = pend.find((x) => x.id === it.dataset.id);
        const c = it.querySelector<HTMLElement>("[data-countdown]");
        if (a && c) c.textContent = `Hermes keeps asking in its own UI too · first answer wins · falls back in ${mmss(a.expiresAt - now)}`;
      });
    }
    el.hidden = false;
    el.classList.toggle("has-pending", pend.length > 0);
  }

  /** The task box under the Hermes panel: an input part (re-rendered only on its own steps) and a status list. */
  renderTasks() {
    const el = this.ensure("ctl-tasks", "#hermes-box", "ctl-tasks");
    if (!el) return;
    const s = this.state;
    if (!this.paired || !s?.policy.remoteTasks) { el.hidden = true; el.innerHTML = ""; delete el.dataset.mode; return; }
    el.hidden = false;
    const mode = this.confirming ? "confirm" : "input";
    if (el.dataset.mode !== mode) {
      el.dataset.mode = mode;
      el.innerHTML = `<div data-part="input"></div><ul class="ctl-cmds" data-part="list"></ul>`;
      const box = el.querySelector<HTMLElement>('[data-part="input"]')!;
      box.innerHTML = this.confirming
        ? `<div class="ctl-confirm" role="alertdialog" aria-label="Confirm task"><p><b>Send this to Hermes?</b> It runs on your Hermes server with its tools, under Hermes' own approval rules.</p><pre class="diff"><span>${esc(this.draft)}</span></pre>
           <div class="task-row"><button type="button" class="btn btn-primary btn-sm" data-task="send">Send to Hermes</button><button type="button" class="btn btn-sm" data-task="back">Edit</button></div></div>`
        : `<label class="sr-only" for="ctl-prompt">Task for Hermes</label><textarea id="ctl-prompt" rows="2" maxlength="4000" placeholder="Send Hermes a task…" spellcheck="false">${esc(this.draft)}</textarea>
           <div class="task-row"><span class="task-mode">Runs through Hermes' API server</span><span class="spacer"></span><button type="button" class="btn btn-primary btn-sm" data-task="review" ${this.draft.trim() ? "" : "disabled"}>Send…</button></div>`;
      const ta = box.querySelector<HTMLTextAreaElement>("#ctl-prompt");
      const review = () => { if (!this.draft.trim()) return; this.confirming = true; this.renderTasks(); };
      ta?.addEventListener("input", () => { this.draft = ta.value; box.querySelector<HTMLButtonElement>('[data-task="review"]')!.disabled = !ta.value.trim(); });
      ta?.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) review(); });
      box.querySelector('[data-task="review"]')?.addEventListener("click", review);
      box.querySelector('[data-task="back"]')?.addEventListener("click", () => { this.confirming = false; this.renderTasks(); });
      box.querySelector<HTMLButtonElement>('[data-task="send"]')?.addEventListener("click", (e) => { (e.currentTarget as HTMLButtonElement).disabled = true; void this.sendTask(); });
    }
    const list = el.querySelector<HTMLElement>('[data-part="list"]')!;
    const recent = s.commands.filter((c) => c.kind === "run").slice(0, 3);
    const html = recent.map((c) => `<li data-id="${esc(c.id)}"><span class="ctl-state s-${esc(c.status)}">${esc(CMD_TXT[c.status])}</span> <span class="ctl-p">${esc(c.prompt.length > 70 ? c.prompt.slice(0, 69) + "…" : c.prompt)}</span>
          ${c.status === "queued" ? `<button type="button" class="link-btn" data-cancel>Cancel</button>` : c.status === "started" ? `<button type="button" class="link-btn" data-stop>Stop</button>` : ""}
          ${c.error ? `<br><small>${esc(c.error)}</small>` : ""}</li>`).join("");
    if (list.dataset.html === html) return;
    list.dataset.html = html;
    list.innerHTML = html;
    list.hidden = !recent.length;
    list.querySelectorAll<HTMLElement>("[data-cancel]").forEach((b) => b.addEventListener("click", () => void this.cmdAction(b.closest<HTMLElement>("li")!.dataset.id!, "cancel")));
    list.querySelectorAll<HTMLElement>("[data-stop]").forEach((b) => b.addEventListener("click", () => void this.cmdAction(b.closest<HTMLElement>("li")!.dataset.id!, "stop")));
  }

  private async sendTask() {
    const prompt = this.draft.trim();
    if (!prompt) return;
    const r = await this.api("POST", "commands", { kind: "run", prompt, confirm: true });
    if (r.status === 201) {
      this.draft = "";
      this.host.toast("Task sent. Hermes picks it up within a few seconds.");
    } else this.host.toast(`Could not send: ${r.json?.error ?? `HTTP ${r.status}`}`);
    this.confirming = false;
    this.renderTasks();
    await this.refresh();
  }

  private async cmdAction(id: string, what: "cancel" | "stop") {
    const r = what === "cancel" ? await this.api("POST", `commands/${id}/cancel`, {}) : await this.api("POST", "commands", { kind: "stop", target: id, confirm: true });
    if (r.status >= 300) this.host.toast(r.json?.error ?? `HTTP ${r.status}`);
    else this.host.toast(what === "cancel" ? "Task cancelled." : "Asked Hermes to stop the task.");
    await this.refresh();
  }

  // ---------- the Remote control overlay ----------
  open() {
    let el = document.getElementById("control");
    if (!el) {
      el = document.createElement("div");
      el.id = "control";
      el.className = "overlay overlay-narrow";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", "Remote control");
      el.hidden = true;
      document.body.appendChild(el);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el!.hidden) this.close(); });
    }
    for (const o of document.querySelectorAll<HTMLElement>(".overlay")) if (o !== el) o.hidden = true;
    el.hidden = false;
    this.audit = null;
    this.renderOverlay();
    void this.refresh().then(() => this.loadAudit());
    el.querySelector<HTMLElement>("button, input")?.focus();
  }

  close() { const el = document.getElementById("control"); if (el) el.hidden = true; }

  private async loadAudit() {
    if (!this.paired) return;
    const r = await this.api<{ entries: AuditEntry[]; publicKey: string; verified: { ok: boolean } }>("GET", "audit");
    if (r.status !== 200) return;
    // verify the signed chain here too, with the office's public key
    const v = await verifyAudit(r.json.entries, r.json.publicKey).catch(() => ({ ok: false, error: "verification failed" }));
    this.audit = { entries: r.json.entries, ok: v.ok, error: (v as { error?: string }).error };
    this.renderOverlay();
  }

  renderOverlay() {
    const el = document.getElementById("control");
    if (!el || el.hidden) return;
    const s = this.state;
    const head = `<div class="ov-head"><h2>Remote control</h2><span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div>`;
    let body = "";
    if (!this.office) body = `<p>Open your Hermes office first.</p>`;
    else if (!this.paired) {
      body = this.canEnable
        ? `<p>Answer Hermes' approvals, send it tasks and get notified when it needs you, from this browser or your phone. <b>Off by default</b>: nothing changes until you turn it on here <i>and</i> on the Hermes machine.</p>
           <label class="field"><span>Name this device</span><input data-f="device" value="${esc(defaultDeviceName())}" maxlength="40"><small>Shown in the audit log next to every answer it gives.</small></label>
           <div class="task-row"><button type="button" class="btn btn-primary" data-act="enable">Turn on remote control</button></div>
           ${this.err ? `<div class="err" role="alert">${esc(this.err)}</div>` : ""}`
        : `<p>This is a read-only viewer. To answer approvals from this device, open a <b>pairing link</b> from a device that already has remote control (Remote control → Pair a phone).</p>${this.err ? `<div class="err" role="alert">${esc(this.err)}</div>` : ""}`;
    } else if (!s) body = `<p>Loading…</p>${this.err ? `<div class="err" role="alert">${esc(this.err)}</div>` : ""}`;
    else body = this.overlayBody(s);
    el.innerHTML = `${head}<div class="settings ctl-settings">${body}</div>`;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.bindOverlay(el);
  }

  private overlayBody(s: State): string {
    const n = s.notify;
    const me = s.devices.find((d) => d.current);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const pushOk = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const subscribed = s.push.mine.length > 0;
    const plugin = [
      "# on the Hermes machine: ~/.hermes/.env",
      ...(s.policy.remoteApproval ? ["OVERTIME_REMOTE_APPROVAL=1"] : []),
      ...(s.policy.remoteTasks ? ["OVERTIME_REMOTE_TASKS=1", "API_SERVER_ENABLED=true   # tasks start via POST /v1/runs", "API_SERVER_KEY=<a long random key>"] : []),
      ...(!s.policy.remoteApproval && !s.policy.remoteTasks ? ["# switch something on above first"] : []),
      "",
      "# plus the remote-control file next to the plugin, then restart the gateway",
      `curl -fsSL ${location.origin}/hermes-overtime/overtime_control.py -o ~/.hermes/plugins/hermes-overtime/overtime_control.py`,
    ].join("\n");
    const trig: Record<Trigger, string> = { approval: "Approval or input waiting", error: "Error or failed session", stuck: "Looks stuck (no activity)", finished: "Session finished", budget: "Budget exceeded" };
    const audit = this.audit;
    return `
      <p>This device is <b>${esc(me?.name ?? "paired")}</b>. Control tokens are separate from the viewer link: the viewer link can never approve anything.</p>
      <h3>What Overtime may do</h3>
      <label class="check"><input type="checkbox" data-pol="remoteApproval" ${s.policy.remoteApproval ? "checked" : ""}> Answer Hermes' approvals (gateway sessions: Telegram, Discord, Slack, API server…)</label>
      <label class="check"><input type="checkbox" data-pol="remoteTasks" ${s.policy.remoteTasks ? "checked" : ""}> Send tasks to Hermes</label>
      <p>Hermes must opt in too. If Overtime does not answer in time, Hermes keeps its normal approval prompt; Overtime never approves on its own and cannot choose "always". CLI sessions stay in the terminal.</p>
      <div class="hx-snippet"><pre data-snippet>${esc(plugin)}</pre><button type="button" class="btn btn-sm" data-copy>Copy</button></div>

      <h3>Notifications</h3>
      <label class="check"><input type="checkbox" data-n="enabled" ${n.enabled ? "checked" : ""}> Notify me when Hermes needs me</label>
      <div class="ctl-grid">${TRIGGERS.map((t) => `<label class="check"><input type="checkbox" data-trig="${t}" ${n.triggers[t] ? "checked" : ""}> ${trig[t]}</label>`).join("")}</div>
      <div class="ctl-quiet"><label class="check"><input type="checkbox" data-q="on" ${n.quiet.on ? "checked" : ""}> Quiet hours</label>
        <label class="field ctl-time"><span class="sr-only">From</span><input type="time" data-q="start" value="${esc(n.quiet.start)}"></label><span>to</span>
        <label class="field ctl-time"><span class="sr-only">To</span><input type="time" data-q="end" value="${esc(n.quiet.end)}"></label>
        <small>${esc(n.quiet.on ? n.quiet.tz : tz)}</small></div>
      <div class="ctl-quiet ctl-budget"><span>Budget</span>
        <label class="field ctl-time"><span class="sr-only">Daily budget in USD</span><input type="number" min="0" step="0.01" inputmode="decimal" data-b="dailyUsd" placeholder="per day" value="${n.budget.dailyUsd ?? ""}"></label>
        <label class="field ctl-time"><span class="sr-only">Monthly budget in USD</span><input type="number" min="0" step="0.01" inputmode="decimal" data-b="monthlyUsd" placeholder="per month" value="${n.budget.monthlyUsd ?? ""}"></label>
        <small>USD, checked by the office itself on every model call</small></div>
      <p>Each message links to this office's viewer. The same alert goes out at most once per ${Math.round(n.dedupeS / 60)} min, ${n.maxPerHour} per hour per channel; "stuck" means ${n.stuckMinutes} min without events in a working session.</p>
      <div class="ctl-channel">
        <b>Telegram</b> ${s.telegram.set ? `<span class="ctl-ok">connected${s.telegram.server ? " (server bot)" : ` · chat ${esc(s.telegram.chatId)} · token …${esc(s.telegram.tokenTail)}`}</span> <button type="button" class="link-btn" data-act="tg-clear">Remove</button>`
          : `<span class="cost-meta">your own bot: create one with @BotFather, send it a message, then get your chat id (e.g. from @userinfobot)</span>
          <label class="field"><span>Bot token</span><input data-f="tg-token" autocomplete="off" spellcheck="false" placeholder="123456789:AA…"></label>
          <label class="field"><span>Chat id</span><input data-f="tg-chat" autocomplete="off" spellcheck="false" placeholder="123456789"></label>
          ${s.telegram.serverAvailable ? `<button type="button" class="link-btn" data-act="tg-server">Use this deployment's bot instead</button>` : ""}
          <small class="cost-meta">Stored encrypted in your office; never shown again.</small>`}
      </div>
      <div class="ctl-channel"><b>Push on this device</b> ${!pushOk ? `<span class="cost-meta">this browser has no Web Push</span>` : subscribed ? `<span class="ctl-ok">on</span> <button type="button" class="link-btn" data-act="push-off">Turn off</button>` : `<button type="button" class="btn btn-sm" data-act="push-on">Enable push here</button>`}
        <small class="cost-meta">${s.push.subscriptions} device${s.push.subscriptions === 1 ? "" : "s"} subscribed. On Android, Chrome shows them even when the tab is closed.</small></div>
      <div class="task-row"><button type="button" class="btn btn-primary btn-sm" data-act="save-notify">Save notifications</button><button type="button" class="btn btn-sm" data-act="test">Send a test</button><span class="cost-meta" data-msg></span></div>
      ${s.sent.length ? `<details><summary>Recent deliveries</summary><ul class="ctl-audit">${s.sent.map((x) => `<li><span>${esc(when(x.at))}</span> ${esc(x.trig)} → ${esc(x.channel.split(":")[0])}: ${esc(x.result)}</li>`).join("")}</ul></details>` : ""}

      <h3>Devices</h3>
      <ul class="ctl-devices">${s.devices.map((d) => `<li data-id="${esc(d.id)}"><b>${esc(d.name)}</b>${d.current ? " (this device)" : ""}<br><span class="cost-meta">paired ${esc(when(d.createdAt))} · last seen ${esc(when(d.lastSeen))}</span>${d.current ? "" : ` <button type="button" class="link-btn" data-revoke>Remove</button>`}</li>`).join("")}</ul>
      <div class="ctl-pair"><label class="field"><span>Pair a phone</span><input data-f="pair-name" placeholder="My phone" maxlength="40"></label><button type="button" class="btn btn-sm" data-act="pair">Create pairing link</button></div>
      ${this.pairLink ? `<div class="hx-snippet"><pre data-pairlink>${esc(this.pairLink)}</pre><button type="button" class="btn btn-sm" data-copy-pair>Copy</button></div><p>Open it on the phone within 10 minutes. It works <b>once</b>: the phone swaps it for its own control token, and the code leaves the address bar as soon as the page opens. Send it privately.</p>` : ""}

      <h3>Audit log</h3>
      ${audit ? `<p class="${audit.ok ? "ctl-ok" : "err"}">${audit.ok ? `Signature chain verified in this browser (${audit.entries.length} entries, ECDSA P-256).` : `Verification failed: ${esc(audit.error ?? "")}`}</p>
        <ol class="ctl-audit">${audit.entries.slice().reverse().slice(0, 60).map((e) => `<li><span>${esc(when(e.at))}</span> ${esc(describeAudit(e))}</li>`).join("")}</ol>` : `<p class="cost-meta">Loading…</p>`}
      <div class="task-row"><span class="spacer"></span><button type="button" class="link-btn" data-act="forget">Forget remote control on this device</button></div>`;
  }

  private bindOverlay(el: HTMLElement) {
    const q = <T extends HTMLElement = HTMLInputElement>(s: string) => el.querySelector<T>(s);
    const msg = (t: string) => { const m = q<HTMLElement>("[data-msg]"); if (m) m.textContent = t; };
    q('[data-act="enable"]')?.addEventListener("click", () => void this.enable(q<HTMLInputElement>('[data-f="device"]')?.value ?? ""));
    el.querySelectorAll<HTMLInputElement>("[data-pol]").forEach((c) => c.addEventListener("change", async () => {
      const r = await this.api("POST", "policy", { [c.dataset.pol!]: c.checked });
      if (r.status !== 200) this.host.toast(r.json?.error ?? "Could not save");
      await this.refresh();
    }));
    q("[data-copy]")?.addEventListener("click", () => void this.copy(q<HTMLElement>("[data-snippet]")!.textContent ?? "", "Copied. Paste it on your Hermes machine."));
    q("[data-copy-pair]")?.addEventListener("click", () => void this.copy(this.pairLink, "Pairing link copied. Open it on your phone."));
    q('[data-act="save-notify"]')?.addEventListener("click", async () => {
      const s = this.state!;
      const settings = {
        enabled: q<HTMLInputElement>('[data-n="enabled"]')!.checked,
        triggers: Object.fromEntries(TRIGGERS.map((t) => [t, q<HTMLInputElement>(`[data-trig="${t}"]`)!.checked])),
        budget: Object.fromEntries((["dailyUsd", "monthlyUsd"] as const).map((k) => { const v = Number(q<HTMLInputElement>(`[data-b="${k}"]`)?.value); return [k, v > 0 ? v : null]; })),
        quiet: { on: q<HTMLInputElement>('[data-q="on"]')!.checked, start: q<HTMLInputElement>('[data-q="start"]')!.value || "22:00", end: q<HTMLInputElement>('[data-q="end"]')!.value || "07:00", tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      };
      const tok = q<HTMLInputElement>('[data-f="tg-token"]')?.value.trim();
      const chat = q<HTMLInputElement>('[data-f="tg-chat"]')?.value.trim();
      const body: Record<string, unknown> = { settings };
      if (!s.telegram.set && (tok || chat)) body.telegram = { token: tok, chatId: chat };
      const r = await this.api("POST", "notify", body);
      msg(r.status === 200 ? "Saved." : r.json?.error ?? `HTTP ${r.status}`);
      if (r.status === 200) await this.refresh().then(() => msg("Saved."));
    });
    q('[data-act="tg-clear"]')?.addEventListener("click", async () => { await this.api("POST", "notify", { telegram: { clear: true } }); await this.refresh(); });
    q('[data-act="tg-server"]')?.addEventListener("click", async () => { const r = await this.api("POST", "notify", { telegram: { useServer: true } }); if (r.status !== 200) this.host.toast(r.json?.error ?? "error"); await this.refresh(); });
    q('[data-act="test"]')?.addEventListener("click", async () => {
      const r = await this.api<{ results: { channel: string; ok: boolean; status?: number; reason?: string }[] }>("POST", "notify/test", {});
      msg(r.status === 200 ? r.json.results.map((x) => `${x.channel.split(":")[0]}: ${x.ok ? "sent" : x.reason ?? `HTTP ${x.status}`}`).join(" · ") : `HTTP ${r.status}`);
    });
    q('[data-act="push-on"]')?.addEventListener("click", () => void this.enablePush().then((t) => msg(t)));
    q('[data-act="push-off"]')?.addEventListener("click", () => void this.disablePush().then((t) => msg(t)));
    q('[data-act="pair"]')?.addEventListener("click", async () => {
      const name = q<HTMLInputElement>('[data-f="pair-name"]')?.value || "Phone";
      const r = await this.api<{ watch: string }>("POST", "devices", { name });
      if (r.status !== 201) { this.host.toast((r.json as any)?.error ?? `HTTP ${r.status}`); return; }
      this.pairLink = r.json.watch;
      await this.refresh();
    });
    el.querySelectorAll<HTMLElement>("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this device? It loses remote control at once.")) return;
      await this.api("POST", `devices/${b.closest<HTMLElement>("li")!.dataset.id}/revoke`, {});
      await this.refresh();
    }));
    q('[data-act="forget"]')?.addEventListener("click", () => {
      if (!confirm("Forget the control token on this device? Pair it again with a link from another device (or, if no device is left, from the owner's tab).")) return;
      this.save(null);
      this.state = null;
      this.renderAll();
    });
  }

  private async enable(name: string) {
    if (!this.office?.ingestToken) return;
    const r = await this.api<{ controlToken: string; deviceId: string; deviceName: string; error?: string }>("POST", "enable", { device: name || defaultDeviceName() }, this.office.ingestToken);
    if (r.status !== 201) { this.err = r.json?.error ?? `HTTP ${r.status}`; this.renderOverlay(); return; }
    this.save({ token: r.json.controlToken, deviceId: r.json.deviceId, deviceName: r.json.deviceName });
    this.host.toast("Remote control is on for this device. Now choose what Overtime may do.");
    await this.refresh();
    void this.loadAudit();
  }

  private async enablePush(): Promise<string> {
    const s = this.state;
    if (!s) return "";
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return "Notifications are blocked for this site.";
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(s.push.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.push.vapidPublicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      const r = await this.api("POST", "push/subscribe", { subscription: sub.toJSON() });
      await this.refresh();
      return r.status === 201 ? "Push is on for this device." : (r.json?.error ?? `HTTP ${r.status}`);
    } catch (e) {
      return `Could not enable push: ${(e as Error).message}`;
    }
  }

  private async disablePush(): Promise<string> {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      for (const ep of new Set([...(this.state?.push.mine ?? []), ...(sub ? [sub.endpoint] : [])])) await this.api("POST", "push/unsubscribe", { endpoint: ep });
      await sub?.unsubscribe();
    } catch { /* still removed server-side */ }
    await this.refresh();
    return "Push is off for this device.";
  }

  private async copy(text: string, ok: string) {
    try { await navigator.clipboard.writeText(text); this.host.toast(ok); } catch { window.prompt("Copy this:", text); }
  }
}
