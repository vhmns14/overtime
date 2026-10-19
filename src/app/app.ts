// UI controller: wires the orchestrator's events to the office, the side panel, approvals,
// files/diff/preview, settings and history. Vanilla TS + small render functions.

import { Orchestrator, DEFAULT_CONFIG } from "../engine/orchestrator";
import { PRESETS } from "../engine/llm";
import { lineDiff, diffStats } from "../engine/diff";
import { buildZip } from "../engine/zip";
import { store } from "../engine/storage";
import { ROLES, ROLE_INFO, STEPS, type DiffLine, type GateRequest, type LogEntry, type Role, type RunEvent, type Snapshot, type StepId, type StepState } from "../engine/types";
import { DEMO_TASK, DEMO_PRICING } from "../demo/demo-llm";
import { Office, portraitURL } from "../office/scene";
import { wordmarkSVG } from "../ui/wordmark";
import { buildLLM, loadSettings, saveSettings, secrets, type Settings } from "./settings";
import { deployToWorker, fetchRef, inlinePreview, pushToGitHub, esc } from "./deploy";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

interface HistoryItem {
  id: string;
  task: string;
  status: string;
  at: number;
  usd: number;
  tokens: number;
  mode: string;
  files: Record<string, string>;
  snapshots: Snapshot[];
  url: string;
  log: LogEntry[];
}
const HISTORY_KEY = "overtime:history:v1";

function runTitle(task: string) {
  const m = task.match(/landing page for (.+?)\.?$/i);
  if (m) return `${m[1]} landing page`;
  return task.length > 42 ? task.slice(0, 40) + "…" : task;
}

function newRunId() {
  const r = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `run-${Date.now().toString(36)}-${r}`;
}

export class App {
  private s: Settings;
  private office!: Office;
  private orch: Orchestrator | null = null;
  private runId = "";
  private startedAt = 0;
  private portraits = {} as Record<Role, string>;
  private selected: Role | null = null;
  private files: Record<string, string> = {};
  private snapshots: Snapshot[] = [];
  private deployed: { url: string; local: boolean } | null = null;
  private viewing: HistoryItem | null = null;
  private filesState = { tab: "files" as "files" | "preview", path: "index.html", version: -1, diff: false };
  private lastThought = {} as Record<Role, string>;
  private speed: number;

  constructor(private bg: HTMLImageElement, private atlas: HTMLImageElement) {
    this.s = loadSettings();
    const q = new URLSearchParams(location.search);
    this.speed = Number(q.get("speed")) > 0 ? Number(q.get("speed")) : this.s.demoSpeed;
  }

  mount() {
    for (const el of document.querySelectorAll<HTMLElement>(".mark")) el.innerHTML = wordmarkSVG();
    for (const r of ROLES) this.portraits[r] = portraitURL(this.atlas, r);
    this.office = new Office($("#office"), this.bg, this.atlas, { speed: this.speed, onSelect: (r) => this.selectAgent(r) });
    const task = $<HTMLTextAreaElement>("#task");
    task.value = DEMO_TASK;
    $("#run-title").textContent = runTitle(DEMO_TASK);
    task.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $<HTMLFormElement>("#task-form").requestSubmit(); } });
    $("#task-form").addEventListener("submit", (e) => { e.preventDefault(); void this.start(); });
    $("#notes-toggle").addEventListener("click", () => { const w = $("#notes-wrap"); w.hidden = !w.hidden; $("#notes-toggle").textContent = w.hidden ? "+ Brief notes" : "− Brief notes"; });
    $("#pause-btn").addEventListener("click", () => { if (!this.orch) return; if (this.orch.status === "paused") this.orch.resume(); else this.orch.pause(); });
    $("#cancel-btn").addEventListener("click", () => this.orch?.cancel());
    $("#cost").addEventListener("click", () => { const b = $("#cost-break"); b.hidden = !b.hidden; $("#cost").setAttribute("aria-expanded", String(!b.hidden)); });
    for (const b of document.querySelectorAll<HTMLElement>("[data-open]")) b.addEventListener("click", () => this.open(b.dataset.open as "files" | "settings" | "history"));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const id of ["files", "settings", "history"]) if (!$(`#${id}`).hidden) { this.close(id); return; }
      if (!$("#agent-card").hidden) this.selectAgent(null);
    });
    this.renderSteps(Object.fromEntries(STEPS.map((s) => [s.id, { state: "pending" }])) as Record<StepId, { state: StepState; pct?: number }>);
    this.renderLog([]);
    this.renderCost(0, 0, null);
    this.renderChrome();
  }

  // ---------- run lifecycle ----------
  private async start() {
    if (this.orch && ["running", "waiting", "paused"].includes(this.orch.status)) return;
    const task = $<HTMLTextAreaElement>("#task").value.trim() || DEMO_TASK;
    if (this.s.mode === "live" && !secrets.apiKey(this.s) && !/localhost|127\.0\.0\.1/.test(this.s.baseUrl)) {
      this.open("settings");
      this.toast("Add your API key (it stays in this browser) or switch to Demo.");
      return;
    }
    this.viewing = null;
    this.files = {};
    this.snapshots = [];
    this.deployed = null;
    this.lastThought = {} as Record<Role, string>;
    this.runId = newRunId();
    this.startedAt = Date.now();
    this.office.reset();
    this.office.speed = this.s.mode === "demo" ? this.speed : 1;
    const demo = this.s.mode === "demo";
    const ghToken = secrets.ghToken();
    const push = !demo && this.s.ghRepo && ghToken
      ? (files: Record<string, string>) => pushToGitHub({ repo: this.s.ghRepo, branch: this.s.ghBranch || "overtime-preview", token: ghToken }, files, `Overtime: ${task.slice(0, 60)}`)
      : undefined;
    const orch = new Orchestrator({
      llm: buildLLM(this.s, this.speed),
      runId: this.runId,
      config: {
        ...DEFAULT_CONFIG,
        task: demo ? DEMO_TASK : task,
        notes: $<HTMLTextAreaElement>("#notes").value.trim() || undefined,
        refUrl: $<HTMLInputElement>("#ref-url").value.trim() || undefined,
        gates: { ...this.s.gates },
        budgetUsd: this.s.budgetUsd,
        pricing: demo ? DEMO_PRICING : { input: this.s.priceIn, output: this.s.priceOut },
      },
      fetchRef,
      deploy: (id, files) => deployToWorker(id, demo ? DEMO_TASK : task, files),
      push,
      pace: {
        handoff: (from, to, summary) => this.office.meeting(from, to, summary),
        tickets: (t) => this.office.whiteboard(t),
      },
    });
    if (demo) { $<HTMLTextAreaElement>("#task").value = DEMO_TASK; }
    $("#run-title").textContent = runTitle(demo ? DEMO_TASK : task);
    this.orch = orch;
    $("#result").hidden = true;
    this.hideGate();
    this.renderLog([]);
    orch.on((e) => this.onEvent(e));
    this.renderChrome();
    await orch.run();
    this.saveHistory(orch);
    this.renderChrome();
  }

  private onEvent(e: RunEvent) {
    const o = this.orch!;
    switch (e.type) {
      case "status":
        if (["done", "failed", "cancelled", "budget"].includes(e.status)) { this.hideGate(); this.office.clearWaiting(); }
        this.renderChrome();
        break;
      case "log": this.renderLog(o.log); break;
      case "agent": {
        const st = e.state;
        if (st.activity === "working") this.office.setWorking(e.role, true);
        else if (st.activity === "idle") this.office.setWorking(e.role, false);
        if (st.thought && st.thought !== this.lastThought[e.role] && st.activity === "working") {
          this.lastThought[e.role] = st.thought;
          this.office.say(e.role, st.thought.length > 64 ? st.thought.slice(0, 62) + "…" : st.thought, "think", 2600);
        }
        if (this.selected === e.role) this.renderAgentCard();
        break;
      }
      case "step": this.renderSteps(o.steps); break;
      case "tickets": if (o.steps.plan.state === "done") this.office.setTickets(e.tickets); break;
      case "files": this.files = e.files; if (!$("#files").hidden) this.renderFiles(); break;
      case "snapshot": this.snapshots = [...o.snapshots]; if (!$("#files").hidden) this.renderFiles(); break;
      case "cost": this.renderCost(e.usd, e.tokens, e.byAgent); break;
      case "gate": this.showGate(e.gate); this.office.setWaiting(e.gate.agent); break;
      case "gate-closed": this.hideGate(); this.office.clearWaiting(); break;
      case "deployed": this.deployed = { url: e.url, local: e.local }; break;
      case "done": this.renderResult(); break;
      default: break;
    }
  }

  private renderChrome() {
    const st = this.orch?.status ?? "idle";
    const active = ["running", "waiting", "paused"].includes(st);
    $("#app").classList.toggle("is-running", active);
    $<HTMLTextAreaElement>("#task").disabled = active;
    $<HTMLButtonElement>("#run-btn").hidden = active;
    $<HTMLButtonElement>("#run-btn").textContent = this.orch ? (this.s.mode === "demo" ? "Run demo again" : "Run again") : this.s.mode === "demo" ? "Run demo" : "Run";
    $("#pause-btn").hidden = !active || st === "waiting";
    $("#pause-btn").textContent = st === "paused" ? "Resume" : "Pause";
    $("#cancel-btn").hidden = !active;
    $("#notes-toggle").hidden = active;
    if (active) $("#notes-wrap").hidden = true;
    $("#task-mode").textContent = this.s.mode === "demo" ? (active ? "Demo run" : "Demo · no key") : active ? "Live run" : `Live · ${this.s.model}`;
    const label: Record<string, string> = { idle: "ready", running: "working", waiting: "waiting for you", paused: "paused", done: "done", failed: "failed", cancelled: "cancelled", budget: "budget cap hit" };
    $("#mode-chip").innerHTML = `${this.s.mode === "demo" ? "<b>Demo</b> · recorded run" : `<b>Live</b> · ${esc(this.s.model)}`} · ${label[st]}`;
    $("#mode-chip").dataset.status = st;
  }

  // ---------- panel pieces ----------
  private renderSteps(steps: Record<StepId, { state: StepState; pct?: number }>) {
    const v = $("#steps"), h = $("#steps-h");
    v.innerHTML = STEPS.map(({ id, label }) => {
      const s = steps[id];
      const stateText = s.state === "done" ? "✓" : s.state === "active" ? (id === "code" && s.pct !== undefined ? `${s.pct}%` : "working") : s.state;
      const bar = id === "code" && (s.state === "active" || (s.state === "done" && false)) ? `<span class="bar"><i style="width:${s.pct ?? 0}%"></i></span>` : "";
      return `<li class="step ${s.state}" data-step="${id}"><span class="dot"></span><span class="label">${label}</span><span class="state">${stateText}</span>${bar}</li>`;
    }).join("");
    h.innerHTML = STEPS.map(({ id, label }) => {
      const s = steps[id];
      const pip = s.state === "active" && id === "code" && s.pct !== undefined ? `${s.pct}%` : "";
      return `<li class="${s.state}"><span class="pip">${pip}</span><span>${label}</span></li>`;
    }).join("");
  }

  private renderLog(log: LogEntry[]) {
    const el = $("#log");
    if (!log.length) {
      el.innerHTML = `<li class="empty">${this.s.mode === "demo" ? "Press <b>Run demo</b> to watch the team build the Kopi Senja landing page. No key needed: it replays a recorded run through the real engine and checks." : "Describe a small website or tool and press <b>Run</b>."}</li>`;
      return;
    }
    const rows = log.slice(-200).reverse().map((e) => {
      const sec = Math.max(0, Math.floor((e.t - this.startedAt) / 1000));
      const el = `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}]`;
      const who = e.agent === "system" ? "" : `<b>${ROLE_INFO[e.agent].name}</b> `;
      return `<li class="${e.level ?? "info"}"><time>${el}</time><span>${who}${esc(e.text)}</span></li>`;
    });
    el.innerHTML = rows.join("");
  }

  private renderCost(usd: number, tokens: number, by: Record<Role, { tokens: number; usd: number }> | null) {
    const cap = this.s.budgetUsd;
    $("#cost-usd").textContent = `$${usd.toFixed(2)}`;
    $<HTMLElement>("#cost-fill").style.width = `${Math.min(100, (usd / cap) * 100)}%`;
    const k = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
    $("#cost-meta").textContent = `${k} tokens · cap $${cap.toFixed(2)}${this.s.mode === "demo" ? " · demo" : ""}`;
    $("#cost").classList.toggle("over", usd > cap);
    $("#cost-break").innerHTML = by
      ? ROLES.map((r) => `<span><span>${ROLE_INFO[r].name}</span><span>${by[r].tokens.toLocaleString("en-US")} tok · $${by[r].usd.toFixed(3)}</span></span>`).join("")
      : `<span>No spend yet.</span>`;
    if (this.s.mode === "demo") $("#cost-break").insertAdjacentHTML("beforeend", `<span><span>Demo spend is simulated at gpt-4o list rates.</span></span>`);
  }

  private titleHTML(g: GateRequest) {
    const name = ROLE_INFO[g.agent].name;
    const t = esc(g.title);
    return t.startsWith(name) ? `<b>${name}${t[name.length] === ":" ? ":" : ""}</b>${t.slice(name.length + (t[name.length] === ":" ? 1 : 0))}` : t;
  }

  private diffHTML(d?: DiffLine[]) {
    if (!d?.length) return "";
    return `<pre class="diff">${d.map((l) => `<span class="${l.type}">${l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}${esc(l.text)}</span>`).join("\n")}</pre>`;
  }

  private showGate(g: GateRequest) {
    const items = g.items?.length ? `<details><summary>${g.kind === "plan" ? "Tickets" : g.kind === "deploy" ? "Files" : "Details"} (${g.items.length})</summary><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></details>` : "";
    const body = g.kind === "question" ? `<p>${esc(g.body)}</p>` : "";
    const card = $("#approval");
    card.innerHTML = `<p class="approval-title" id="gate-title">${this.titleHTML(g)}</p>${body}${items}${g.kind === "deploy" ? this.diffHTML(g.diff) : ""}
      <div class="actions"><button class="btn btn-primary" data-act="approve">Approve</button><button class="btn" data-act="reject">Reject</button></div>
      <div class="more"><button class="link-btn" data-act="toggle-comment">${g.kind === "question" ? "Answer" : "Comment"}</button></div>
      <div class="comment" hidden><input aria-label="Comment for the agent" placeholder="${g.kind === "question" ? "Your answer…" : `Feedback for ${ROLE_INFO[g.agent].name} (Reject sends it back)`}" maxlength="1000"><button class="btn btn-sm" data-act="comment">Send</button></div>`;
    card.hidden = false;
    card.dataset.gate = g.id;
    this.bindGate(card, g);
    // phone: full-screen approval like the mockup
    const m = $("#mobile-approval");
    m.innerHTML = `<div class="ma-card"><img alt="${ROLE_INFO[g.agent].name}" src="${this.portraits[g.agent]}"><h2 id="ma-title">${this.titleHTML(g)}</h2>${body}${this.diffHTML(g.diff) || (g.items?.length ? `<ul>${g.items.slice(0, 5).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "")}
      <div class="actions"><button class="btn btn-primary" data-act="approve">Approve</button><button class="btn" data-act="reject">Reject</button></div>
      <div class="comment"><input aria-label="Comment for the agent" placeholder="Optional comment…" maxlength="1000"><button class="btn btn-sm" data-act="comment">Send</button></div>
      <p class="so-far"><b>$${(this.orch?.usage.usd ?? 0).toFixed(2)}</b> so far</p><button class="link-btn ma-cancel" data-act="cancel-run">Cancel run</button></div>`;
    m.hidden = false;
    this.bindGate(m, g);
  }

  private bindGate(root: HTMLElement, g: GateRequest) {
    root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const input = root.querySelector<HTMLInputElement>(".comment input");
      const comment = input?.value.trim() || undefined;
      const act = b.dataset.act!;
      if (act === "cancel-run") { this.orch?.cancel(); return; }
      if (act === "toggle-comment") { const c = root.querySelector<HTMLElement>(".comment")!; c.hidden = !c.hidden; if (!c.hidden) input?.focus(); return; }
      if (act === "comment" && !comment) { input?.focus(); return; }
      this.orch?.decide(g.id, { action: act as "approve" | "reject" | "comment", comment });
    }));
  }

  private hideGate() {
    $("#approval").hidden = true;
    $("#mobile-approval").hidden = true;
  }

  private renderResult() {
    const o = this.orch!;
    const el = $("#result");
    const live = this.deployed && !this.deployed.local;
    el.innerHTML = `<h3>${o.steps.deploy.state === "done" ? "Preview is live" : "Files are ready"}</h3><p>${esc(o.summary)}.${live ? ` Served at <code>${esc(this.deployed!.url)}</code>.` : o.steps.deploy.state === "done" ? " Rendered in-browser (no Worker here)." : ""}</p>
      <div class="row"><button class="btn btn-primary btn-sm" data-r="preview">Open preview</button><button class="btn btn-sm" data-r="files">Files &amp; diff</button><button class="btn btn-sm" data-r="zip">Download ZIP</button>${live ? `<a class="btn btn-sm" href="${esc(this.deployed!.url)}" target="_blank" rel="noopener">New tab ↗</a>` : ""}</div>`;
    el.hidden = false;
    el.querySelector('[data-r="preview"]')!.addEventListener("click", () => { this.filesState.tab = "preview"; this.open("files"); });
    el.querySelector('[data-r="files"]')!.addEventListener("click", () => { this.filesState.tab = "files"; this.open("files"); });
    el.querySelector('[data-r="zip"]')!.addEventListener("click", () => this.downloadZip());
  }

  // ---------- agent card ----------
  private selectAgent(r: Role | null) {
    this.selected = r;
    this.renderAgentCard();
  }

  private renderAgentCard() {
    const el = $("#agent-card");
    const r = this.selected;
    if (!r) { el.hidden = true; return; }
    const st = this.orch?.agents[r];
    const activity = st ? { idle: "idle", working: "working", meeting: "in a handoff", whiteboard: "at the whiteboard", coffee: "on a coffee break", waiting: "waiting for your approval" }[st.activity] : "idle";
    const log = st?.log.slice(-6).reverse() ?? [];
    const files = st?.filesTouched ?? [];
    el.innerHTML = `<header><img alt="" src="${this.portraits[r]}"><div><h3>${ROLE_INFO[r].name}</h3><div class="sub">${ROLE_INFO[r].title} · ${activity}</div></div><button class="link-btn x" aria-label="Close">Close</button></header>
      <p class="thought">${st?.thought ? esc(st.thought) : "No thoughts yet. Start a run."}</p>
      <h4>Recent log</h4><ul>${log.length ? log.map((l) => `<li>${esc(l)}</li>`).join("") : "<li>—</li>"}</ul>
      <h4>Files touched</h4><ul class="files">${files.length ? files.map((f) => `<li data-f="${esc(f)}">${esc(f)}</li>`).join("") : "<li>—</li>"}</ul>
      <h4>Spend</h4><ul><li>${(st?.tokens ?? 0).toLocaleString("en-US")} tokens · $${(st?.cost ?? 0).toFixed(3)}</li></ul>`;
    el.hidden = false;
    el.querySelector(".x")!.addEventListener("click", () => this.selectAgent(null));
    el.querySelectorAll<HTMLElement>("[data-f]").forEach((li) => li.addEventListener("click", () => { this.filesState = { ...this.filesState, tab: "files", path: li.dataset.f!, version: -1 }; this.open("files"); }));
  }

  // ---------- overlays ----------
  private open(which: "files" | "settings" | "history") {
    for (const id of ["files", "settings", "history"]) if (id !== which) $(`#${id}`).hidden = true;
    if (which === "files") this.renderFiles();
    if (which === "settings") this.renderSettings();
    if (which === "history") this.renderHistory();
    const el = $(`#${which}`);
    el.hidden = false;
    el.querySelector<HTMLElement>("button, input, select")?.focus();
  }
  private close(id: string) { $(`#${id}`).hidden = true; }

  private head(title: string, extra = "") {
    return `<div class="ov-head"><h2>${title}</h2>${extra}<span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div>`;
  }

  private currentFiles(): { files: Record<string, string>; snapshots: Snapshot[]; url: string; local: boolean } {
    if (this.viewing) return { files: this.viewing.files, snapshots: this.viewing.snapshots, url: this.viewing.url, local: !this.viewing.url };
    return { files: this.files, snapshots: this.snapshots, url: this.deployed?.url ?? "", local: this.deployed?.local ?? true };
  }

  private renderFiles() {
    const el = $("#files");
    const { files, snapshots, url, local } = this.currentFiles();
    const fs = this.filesState;
    const paths = Object.keys(files).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
    if (!paths.includes(fs.path) && paths.length) fs.path = paths[0];
    const tabs = `<div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="files" aria-selected="${fs.tab === "files"}">Files</button><button class="tab" role="tab" data-tab="preview" aria-selected="${fs.tab === "preview"}">Preview</button></div>`;
    const zip = paths.length ? `<button class="btn btn-sm" data-zip>Download ZIP</button>` : "";
    let body: string;
    if (fs.tab === "files") {
      if (!paths.length) body = `<div class="files-empty">No files yet. The Coder's files appear here as they are written, with diffs between iterations.</div>`;
      else {
        const groups: Record<string, string[]> = {};
        for (const p of paths) { const d = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; (groups[d] ??= []).push(p); }
        const tree = Object.keys(groups).sort().map((d) => `${d ? `<div class="dir">${esc(d)}/</div>` : ""}${groups[d].map((p) => `<button data-path="${esc(p)}" aria-current="${p === fs.path}">${esc(p.split("/").pop()!)}</button>`).join("")}`).join("");
        const withFile = snapshots.map((s, i) => ({ s, i })).filter(({ s }) => fs.path in s.files);
        const version = fs.version >= 0 && withFile.some((x) => x.i === fs.version) ? fs.version : -1;
        const content = version >= 0 ? snapshots[version].files[fs.path] : files[fs.path] ?? "";
        const prevIdx = version >= 0 ? version - 1 : snapshots.length - 1;
        const prev = prevIdx >= 0 ? snapshots[prevIdx]?.files[fs.path] : undefined;
        const base = version >= 0 ? prev : snapshots.length > 1 && files[fs.path] === snapshots[snapshots.length - 1]?.files[fs.path] ? snapshots[snapshots.length - 2]?.files[fs.path] : prev;
        const canDiff = base !== undefined && base !== content;
        let code: string;
        if (fs.diff && canDiff) {
          const full = lineDiff(base!, content);
          let n = 0;
          const numbered = full.map((l) => ({ ...l, n: l.type === "del" ? "" : String(++n) }));
          const keep = new Set<number>();
          numbered.forEach((l, i) => { if (l.type !== "ctx") for (let k = i - 3; k <= i + 3; k++) keep.add(k); });
          let gap = false;
          code = numbered.map((l, i) => {
            if (!keep.has(i)) { if (gap) return ""; gap = true; return `<span class="ln gap" data-n="⋯"></span>`; }
            gap = false;
            return `<span class="ln ${l.type}" data-n="${l.type === "del" ? "−" : l.type === "add" ? "+" + l.n : l.n}">${esc(l.text)}</span>`;
          }).join("");
        } else code = content.split("\n").map((l, i) => `<span class="ln" data-n="${i + 1}">${esc(l)}</span>`).join("");
        const stats = canDiff ? diffStats(lineDiff(base!, content)) : null;
        body = `<div class="files-body"><nav class="tree" aria-label="Files">${tree}</nav><div class="viewer">
          <div class="viewer-bar"><b>${esc(fs.path)}</b><select aria-label="Version" data-version><option value="-1">Latest</option>${withFile.map(({ s, i }) => `<option value="${i}" ${i === version ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
          <label><input type="checkbox" data-diff ${fs.diff && canDiff ? "checked" : ""} ${canDiff ? "" : "disabled"}> Diff vs previous ${stats ? `<span class="cost-meta">(+${stats.added} −${stats.removed})</span>` : ""}</label>
          <span class="cost-meta">${(content.length / 1024).toFixed(1)} KB</span></div>
          <pre class="code" data-code>${code}</pre></div></div>`;
      }
    } else {
      if (!files["index.html"]) body = `<div class="preview-body"><div class="preview-empty">The preview appears once the Coder writes index.html.</div></div>`;
      else {
        const src = !local && url ? `src="${esc(url)}"` : `srcdoc="${esc(inlinePreview(Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith("notes/")))))}"`;
        body = `<div class="preview-body"><iframe title="Site preview" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" ${src}></iframe></div>`;
      }
    }
    el.innerHTML = this.head("Files", tabs + zip + (url && !local ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">New tab ↗</a>` : "")) + body;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("files"));
    el.querySelector("[data-zip]")?.addEventListener("click", () => this.downloadZip());
    el.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => { fs.tab = b.dataset.tab as "files" | "preview"; this.renderFiles(); }));
    el.querySelectorAll<HTMLElement>("[data-path]").forEach((b) => b.addEventListener("click", () => { fs.path = b.dataset.path!; fs.version = -1; this.renderFiles(); }));
    el.querySelector<HTMLSelectElement>("[data-version]")?.addEventListener("change", (e) => { fs.version = Number((e.target as HTMLSelectElement).value); this.renderFiles(); });
    el.querySelector<HTMLInputElement>("[data-diff]")?.addEventListener("change", (e) => { fs.diff = (e.target as HTMLInputElement).checked; this.renderFiles(); });
  }

  private downloadZip() {
    const { files } = this.currentFiles();
    const ship = Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith("notes/")));
    const name = (this.viewing?.task ?? $<HTMLTextAreaElement>("#task").value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site";
    const blob = new Blob([buildZip(ship, name) as BlobPart], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  private renderSettings() {
    const s = this.s;
    const el = $("#settings");
    const key = secrets.apiKey(s);
    el.innerHTML = this.head("Settings") + `<form class="settings" id="settings-form" novalidate>
      <div class="field"><span>Mode</span><div class="seg" role="group" aria-label="Mode"><button type="button" data-mode="demo" aria-pressed="${s.mode === "demo"}">Demo</button><button type="button" data-mode="live" aria-pressed="${s.mode === "live"}">Live (your key)</button></div>
        <small>Demo replays a recorded Kopi Senja run through the real engine. Live runs your own task on your own model.</small></div>
      <h3>Model</h3>
      <label class="field"><span>Provider preset</span><select name="preset">${PRESETS.map((p) => `<option value="${p.id}" ${p.id === s.preset ? "selected" : ""}>${p.label}</option>`).join("")}<option value="custom" ${s.preset === "custom" ? "selected" : ""}>Custom (OpenAI-compatible)</option></select></label>
      <label class="field"><span>Base URL</span><input name="baseUrl" value="${esc(s.baseUrl)}" spellcheck="false"></label>
      <label class="field"><span>Model</span><input name="model" value="${esc(s.model)}" spellcheck="false"></label>
      <label class="field"><span>API key</span><input name="apiKey" type="password" value="${esc(key)}" autocomplete="off" spellcheck="false" placeholder="sk-…"><small>Kept in this browser only (session storage unless you tick remember). Sent per request to the provider, directly or through the stateless Worker proxy. Never stored server-side, never logged.</small></label>
      <label class="check"><input type="checkbox" name="rememberKey" ${s.rememberKey ? "checked" : ""}> Remember the key on this device</label>
      <label class="field"><span>Route</span><select name="route"><option value="proxy" ${s.route === "proxy" ? "selected" : ""}>Through the Worker proxy (no CORS issues)</option><option value="direct" ${s.route === "direct" ? "selected" : ""}>Direct from the browser (provider must allow CORS)</option></select></label>
      <label class="check"><input type="checkbox" name="jsonMode" ${s.jsonMode ? "checked" : ""}> Ask for JSON mode (auto-off if the provider refuses)</label>
      <div class="row2"><label class="field"><span>$ / 1M input tokens</span><input name="priceIn" type="number" step="any" min="0" value="${s.priceIn}"></label><label class="field"><span>$ / 1M output tokens</span><input name="priceOut" type="number" step="any" min="0" value="${s.priceOut}"></label></div>
      <label class="field"><span>Budget cap per run (USD)</span><input name="budgetUsd" type="number" step="any" min="0.01" value="${s.budgetUsd}"><small>The run stops before it spends more than this.</small></label>
      <h3>Approval gates</h3>
      <label class="check"><input type="checkbox" name="g_plan" ${s.gates.plan ? "checked" : ""}> Approve the PM's plan</label>
      <label class="check"><input type="checkbox" name="g_review" ${s.gates.review ? "checked" : ""}> Ask me when the Reviewer finds failures</label>
      <label class="check"><input type="checkbox" name="g_deploy" ${s.gates.deploy ? "checked" : ""}> Approve before deploy / push</label>
      <h3>GitHub push (optional, live mode)</h3>
      <div class="row2"><label class="field"><span>Repository</span><input name="ghRepo" value="${esc(s.ghRepo)}" placeholder="owner/name" spellcheck="false"></label><label class="field"><span>Branch</span><input name="ghBranch" value="${esc(s.ghBranch)}" spellcheck="false"></label></div>
      <label class="field"><span>Token (fine-grained, contents: write)</span><input name="ghToken" type="password" value="${esc(secrets.ghToken())}" autocomplete="off" spellcheck="false"><small>Session only. The browser talks to api.github.com directly; the token never reaches the Worker.</small></label>
      <h3>Demo</h3>
      <label class="field"><span>Demo speed</span><select name="demoSpeed"><option value="1" ${s.demoSpeed === 1 ? "selected" : ""}>Normal</option><option value="0.5" ${s.demoSpeed === 0.5 ? "selected" : ""}>Fast</option><option value="0.25" ${s.demoSpeed === 0.25 ? "selected" : ""}>Very fast</option></select></label>
      <div class="task-row"><button type="button" class="btn btn-ghost" data-clear>Forget keys</button><span class="spacer"></span><button type="submit" class="btn btn-primary">Save</button></div>
      <p>${store.persistent ? "Settings and run history are saved in this browser." : "Storage is unavailable here (sandboxed), so settings last for this session only."}</p>
    </form>`;
    const f = el.querySelector<HTMLFormElement>("#settings-form")!;
    let mode = s.mode;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("settings"));
    f.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode as Settings["mode"];
      f.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    (f.elements.namedItem("preset") as HTMLSelectElement).addEventListener("change", (e: Event) => {
      const p = PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
      if (!p) return;
      (f.elements.namedItem("baseUrl") as HTMLInputElement).value = p.baseUrl;
      (f.elements.namedItem("model") as HTMLInputElement).value = p.model;
      (f.elements.namedItem("route") as HTMLSelectElement).value = p.route;
      (f.elements.namedItem("priceIn") as HTMLInputElement).value = String(p.pricing.input);
      (f.elements.namedItem("priceOut") as HTMLInputElement).value = String(p.pricing.output);
    });
    el.querySelector("[data-clear]")!.addEventListener("click", () => { secrets.setApiKey(this.s, ""); secrets.setGhToken(""); this.renderSettings(); this.toast("Keys forgotten."); });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
      const c = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).checked;
      const next: Settings = {
        ...this.s, mode, preset: v("preset"), baseUrl: v("baseUrl") || this.s.baseUrl, model: v("model") || this.s.model, route: v("route") as Settings["route"],
        jsonMode: c("jsonMode"), rememberKey: c("rememberKey"), priceIn: Math.max(0, Number(v("priceIn")) || 0), priceOut: Math.max(0, Number(v("priceOut")) || 0),
        budgetUsd: Math.max(0.01, Number(v("budgetUsd")) || 0.5), gates: { plan: c("g_plan"), review: c("g_review"), deploy: c("g_deploy") },
        ghRepo: v("ghRepo"), ghBranch: v("ghBranch") || "overtime-preview", demoSpeed: Number(v("demoSpeed")) || 1,
      };
      this.s = next;
      if (!new URLSearchParams(location.search).get("speed")) this.speed = next.demoSpeed;
      saveSettings(next);
      secrets.setApiKey(next, v("apiKey"));
      secrets.setGhToken(v("ghToken"));
      this.close("settings");
      if (!this.orch) { this.renderLog([]); this.renderCost(0, 0, null); }
      this.renderChrome();
    });
  }

  private saveHistory(o: Orchestrator) {
    const list = store.getJSON<HistoryItem[]>(HISTORY_KEY, []);
    const item: HistoryItem = { id: this.runId, task: o.config.task, status: o.status, at: this.startedAt, usd: o.usage.usd, tokens: o.usage.tokens, mode: this.s.mode, files: { ...o.files }, snapshots: o.snapshots, url: this.deployed && !this.deployed.local ? this.deployed.url : "", log: o.log.slice(-80) };
    store.setJSON(HISTORY_KEY, [item, ...list.filter((x) => x.id !== item.id)].slice(0, 8));
  }

  private renderHistory() {
    const el = $("#history");
    const list = store.getJSON<HistoryItem[]>(HISTORY_KEY, []);
    el.innerHTML = this.head("History") + `<div class="history">${list.length ? list.map((h, i) => `<button class="run" data-i="${i}"><b>${esc(h.task)}</b><span class="meta">${new Date(h.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${h.status} · ${Object.keys(h.files).length} files · $${h.usd.toFixed(3)} · ${h.mode}</span></button>`).join("") : `<p class="files-empty">Finished runs are kept here (last 8, in this browser).</p>`}</div>`;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("history"));
    el.querySelectorAll<HTMLElement>("[data-i]").forEach((b) => b.addEventListener("click", () => {
      this.viewing = list[Number(b.dataset.i)];
      this.filesState = { tab: "files", path: "index.html", version: -1, diff: false };
      this.open("files");
    }));
  }

  private toast(msg: string) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    Object.assign(t.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: "200", background: "#141210", color: "#f3eee4", padding: "10px 14px", borderRadius: "6px", font: "500 13.5px var(--sans)" });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
}
