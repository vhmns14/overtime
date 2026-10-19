// UI controller: wires the orchestrator's events to the office, the side panel, approvals,
// files/diff/preview, settings and history. Vanilla TS + small render functions.

import { Orchestrator, DEFAULT_CONFIG } from "../engine/orchestrator";
import { PRESETS, testConnection } from "../engine/llm";
import { GitHubClient, GitHubError, PatAuth, type RepoInfo, type BranchInfo } from "../engine/github";
import { repoDeps } from "../engine/repo-run";
import { lineDiff, diffStats } from "../engine/diff";
import { buildZip } from "../engine/zip";
import { basicSyntax } from "../engine/checks";
import { store } from "../engine/storage";
import { ROLES, ROLE_INFO, STEPS, type TaskMode, type DiffLine, type GateRequest, type LogEntry, type Role, type RunEvent, type Snapshot, type StepId, type StepState } from "../engine/types";
import { DEMO_TASK, DEMO_PRICING, type DemoId } from "../demo/demo-llm";
import { DEMO_REPO, DEMO_REPO_BRANCH, DEMO_REPO_TASK } from "../demo/demo-repo";
import { Office, portraitURL } from "../office/scene";
import { wordmarkSVG } from "../ui/wordmark";
import { buildGitHub, buildLLM, llmSettings, loadSettings, saveSettings, secrets, type Settings, type Surface } from "./settings";
import { HermesController } from "./hermes";
import { InsightsController } from "../insights/ui";
import { deployToWorker, fetchRef, inlinePreview, esc } from "./deploy";

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
  kind?: TaskMode;
  repo?: string;
  pr?: { url: string; number: number; branch: string } | null;
  changes?: ChangeView[];
}
interface ChangeView { path: string; status: "added" | "modified" | "deleted"; added: number; removed: number; diff: string }
const HISTORY_KEY = "overtime:history:v1";
const OVERLAYS = ["files", "settings", "history", "github", "hermes", "insights"] as const;
type Overlay = (typeof OVERLAYS)[number];

function runTitle(task: string) {
  if (task === DEMO_REPO_TASK) return "Fix cart quantity bug → PR";
  const m = task.match(/landing page for (.+?)\.?$/i);
  if (m) return `${m[1]} landing page`;
  return task.length > 42 ? task.slice(0, 40) + "…" : task;
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

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
  private filesState = { tab: "files" as "files" | "preview" | "changes", path: "index.html", version: -1, diff: false, change: "" };
  private runKind: TaskMode = "site";
  private gh = { step: "token" as "token" | "repos", login: "", repos: [] as RepoInfo[], branches: [] as BranchInfo[], repo: "", branch: "", filter: "", error: "", busy: false };
  private lastThought = {} as Record<Role, string>;
  private speed: number;
  private hermes!: HermesController;
  private insights!: InsightsController;
  /** /watch/<office>#v=<view token>: a read-only viewer of someone's Hermes office */
  private watch: { id: string; token: string } | null = null;

  constructor(private bg: HTMLImageElement, private atlas: HTMLImageElement) {
    this.s = loadSettings();
    const q = new URLSearchParams(location.search);
    this.speed = Number(q.get("speed")) > 0 ? Number(q.get("speed")) : this.s.demoSpeed;
    const w = location.pathname.match(/^\/watch\/(of-[a-z0-9]{8,24})\/?$/);
    const v = new URLSearchParams(location.hash.slice(1)).get("v");
    if (w && v) this.watch = { id: w[1], token: v };
    const target = q.get("target");
    if (target) this.applyTarget(target);
  }

  /** One select drives everything: Hermes, the Hermes demo, the team demos, or the live team. */
  private applyTarget(v: string) {
    if (v === "hermes" || v === "demo-hermes") this.s.surface = v;
    else if (v === "kopi-senja" || v === "repo-fix") Object.assign(this.s, { surface: "team" as Surface, mode: "demo", demo: v as DemoId });
    else if (v === "site" || v === "repo") Object.assign(this.s, { surface: "team" as Surface, mode: "live", taskKind: v as TaskMode });
    saveSettings(this.s);
  }

  private get onHermes() { return !!this.watch || this.s.surface !== "team"; }

  mount() {
    for (const el of document.querySelectorAll<HTMLElement>(".mark")) el.innerHTML = wordmarkSVG();
    for (const r of ROLES) this.portraits[r] = portraitURL(this.atlas, r);
    this.office = new Office($("#office"), this.bg, this.atlas, { speed: this.speed, onSelect: (r) => this.selectAgent(r) });
    const task = $<HTMLTextAreaElement>("#task");
    task.value = this.defaultTask();
    $("#run-title").textContent = runTitle(task.value);
    $<HTMLSelectElement>("#task-kind").addEventListener("change", (e) => this.onKindChange((e.target as HTMLSelectElement).value));
    $("#repo-btn").addEventListener("click", () => { if (this.s.mode === "live") this.open("github"); });
    // no <form> submits anywhere: sandboxed embeds (no allow-forms) block them before JS can intercept
    task.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.start(); } });
    $("#run-btn").addEventListener("click", () => void this.start());
    $("#notes-toggle").addEventListener("click", () => { const w = $("#notes-wrap"); w.hidden = !w.hidden; $("#notes-toggle").textContent = w.hidden ? "+ Brief notes" : "− Brief notes"; });
    $("#pause-btn").addEventListener("click", () => { if (!this.orch) return; if (this.orch.status === "paused") this.orch.resume(); else this.orch.pause(); });
    $("#cancel-btn").addEventListener("click", () => this.orch?.cancel());
    $("#cost").addEventListener("click", () => { const b = $("#cost-break"); b.hidden = !b.hidden; $("#cost").setAttribute("aria-expanded", String(!b.hidden)); });
    for (const b of document.querySelectorAll<HTMLElement>("[data-open]")) b.addEventListener("click", () => this.open(b.dataset.open as Overlay));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const id of OVERLAYS) if (!$(`#${id}`).hidden) { this.close(id); return; }
      if (!$("#agent-card").hidden) this.selectAgent(null);
    });
    this.hermes = new HermesController({
      office: this.office,
      speed: () => this.speed,
      renderSteps: (st) => this.renderSteps(st),
      renderLog: (log, at, empty) => this.renderLog(log, at, empty),
      renderCost: (usd, tok, by, opts) => this.renderCost(usd, tok, by, opts),
      setTitle: (t) => { $("#run-title").textContent = t; },
      setChip: (html, status) => { $("#mode-chip").innerHTML = html; $("#mode-chip").dataset.status = status; },
      refreshAgentCard: () => { if (this.selected) this.renderAgentCard(); },
      toast: (m) => this.toast(m),
      openOverlay: (id) => this.open(id),
      closeOverlay: (id) => this.close(id),
    });
    this.insights = new InsightsController({
      office: this.office,
      officeEl: $("#office"),
      hermes: this.hermes,
      renderSteps: (st) => this.renderSteps(st),
      renderLog: (log, at, empty) => this.renderLog(log, at, empty),
      renderCost: (usd, tok, by, opts) => this.renderCost(usd, tok, by, opts),
      setChip: (html, status) => { $("#mode-chip").innerHTML = html; $("#mode-chip").dataset.status = status; },
      toast: (m) => this.toast(m),
      openOverlay: () => this.open("insights"),
      closeOverlay: () => this.close("insights"),
      isHermes: () => this.onHermes,
      settings: () => this.s,
      officeAccess: () => this.watch ?? (this.hermes.creds ? { id: this.hermes.creds.runId, token: this.hermes.creds.viewToken } : null),
    });
    this.insights.mount();
    document.addEventListener("overtime:surface", (e) => { this.applyTarget(String((e as CustomEvent).detail)); this.enterSurface(); });
    this.renderSteps(Object.fromEntries(STEPS.map((s) => [s.id, { state: "pending" }])) as Record<StepId, { state: StepState; pct?: number }>);
    this.renderLog([]);
    this.renderCost(0, 0, null);
    this.enterSurface();
  }

  /** (Re)enters the current surface: Hermes office, Hermes demo, read-only viewer, or the team. */
  private enterSurface() {
    if (this.orch && ["running", "waiting", "paused"].includes(this.orch.status)) this.orch.cancel();
    this.insights?.onSurface();
    $("#app").classList.toggle("is-hermes", this.onHermes);
    $("#app").classList.toggle("is-watch", !!this.watch);
    if (this.onHermes) {
      this.orch = null;
      $("#result").hidden = true;
      this.hideGate();
      this.hermes.enter(this.watch ? "watch" : this.s.surface === "demo-hermes" ? "demo-hermes" : "hermes", this.watch ?? undefined);
    } else {
      this.hermes.leave();
      this.office.reset();
      $("#approval").hidden = true;
      delete $("#approval").dataset.ext;
      const t = $<HTMLTextAreaElement>("#task");
      t.value = this.defaultTask();
      $("#run-title").textContent = runTitle(t.value || "New task");
      this.renderSteps(Object.fromEntries(STEPS.map((x) => [x.id, { state: "pending" }])) as Record<StepId, { state: StepState; pct?: number }>);
      this.renderLog([]);
      this.renderCost(0, 0, null);
    }
    this.renderChrome();
  }

  // ---------- task target (site / repo, which demo) ----------
  private currentKind(): TaskMode {
    return this.s.mode === "demo" ? (this.s.demo === "repo-fix" ? "repo" : "site") : this.s.taskKind;
  }

  private defaultTask() {
    if (this.s.mode === "demo") return this.s.demo === "repo-fix" ? DEMO_REPO_TASK : DEMO_TASK;
    return this.s.taskKind === "repo" ? "" : DEMO_TASK;
  }

  private onKindChange(v: string) {
    if (v === "hermes" || v === "demo-hermes" || this.onHermes) {
      this.applyTarget(v);
      this.enterSurface();
      if (v === "repo" && this.s.mode === "live" && (!this.s.ghRepo || !secrets.ghToken(this.s))) this.open("github");
      return;
    }
    const prevDefault = this.defaultTask();
    this.applyTarget(v);
    const t = $<HTMLTextAreaElement>("#task");
    if (this.s.mode === "demo" || !t.value.trim() || t.value === prevDefault) t.value = this.defaultTask();
    t.placeholder = this.currentKind() === "repo" ? "Describe the change, e.g. “Fix the off-by-one in pagination and add a test”" : "Describe a small website, e.g. “A landing page for my coffee shop”";
    $("#run-title").textContent = runTitle(t.value || "New task");
    if (!this.orch || !["running", "waiting", "paused"].includes(this.orch.status)) { this.renderLog([]); this.renderSteps(Object.fromEntries(STEPS.map((x) => [x.id, { state: "pending" }])) as Record<StepId, { state: StepState; pct?: number }>); }
    this.renderChrome();
    if (this.s.mode === "live" && this.s.taskKind === "repo" && (!this.s.ghRepo || !secrets.ghToken(this.s))) this.open("github");
  }

  private renderTarget(active: boolean) {
    const sel = $<HTMLSelectElement>("#task-kind");
    const opts = [
      ["hermes", "Hermes · watch my agent"],
      ["demo-hermes", "Demo · a recorded Hermes session"],
      ["kopi-senja", "Demo · team builds a landing page"],
      ["repo-fix", "Demo · team fixes a bug → PR"],
      ["site", "Team · new static site (your key)"],
      ["repo", "Team · GitHub repo → PR (your key)"],
    ];
    const cur = this.onHermes ? this.s.surface : this.s.mode === "demo" ? this.s.demo : this.s.taskKind;
    const html = opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = cur;
    sel.disabled = active;
    const btn = $<HTMLButtonElement>("#repo-btn");
    const kind = this.currentKind();
    btn.hidden = kind !== "repo" || this.onHermes;
    btn.disabled = active || this.s.mode === "demo";
    if (this.s.mode === "demo") { btn.textContent = `${DEMO_REPO} @ ${DEMO_REPO_BRANCH} · demo`; btn.dataset.state = "ready"; }
    else if (this.s.ghRepo && secrets.ghToken(this.s)) { btn.textContent = `${this.s.ghRepo} @ ${this.s.ghBranch}`; btn.dataset.state = "ready"; btn.title = "Change repository"; }
    else { btn.textContent = "Connect GitHub…"; btn.dataset.state = "empty"; }
  }

  // ---------- run lifecycle ----------
  private async start() {
    if (this.onHermes) { if (this.s.surface === "demo-hermes" && !this.watch) this.hermes.playDemo(); return; }
    if (this.orch && ["running", "waiting", "paused"].includes(this.orch.status)) return;
    const demo = this.s.mode === "demo";
    const kind = this.currentKind();
    const typed = $<HTMLTextAreaElement>("#task").value.trim();
    const task = demo ? this.defaultTask() : typed || (kind === "site" ? DEMO_TASK : "");
    if (!demo && kind === "repo" && !task) { $<HTMLTextAreaElement>("#task").focus(); this.toast("Describe the change you want in the repo."); return; }
    if (!demo && !secrets.apiKey(this.s) && !/localhost|127\.0\.0\.1/.test(this.s.baseUrl)) {
      this.open("settings");
      this.toast("Add your API key (it stays in this browser) or switch to Demo.");
      return;
    }
    if (!demo && kind === "repo" && (!this.s.ghRepo || !this.s.ghBranch || !secrets.ghToken(this.s))) {
      this.open("github");
      this.toast("Connect GitHub and pick a repo first.");
      return;
    }
    this.viewing = null;
    this.files = {};
    this.snapshots = [];
    this.deployed = null;
    this.runKind = kind;
    this.lastThought = {} as Record<Role, string>;
    this.runId = newRunId();
    this.startedAt = Date.now();
    this.office.reset();
    this.office.speed = demo ? this.speed : 1;
    this.filesState = { tab: kind === "repo" ? "changes" : "files", path: "index.html", version: -1, diff: false, change: "" };
    const target = demo ? { repo: DEMO_REPO, branch: DEMO_REPO_BRANCH } : { repo: this.s.ghRepo, branch: this.s.ghBranch };
    const repoHooks = kind === "repo" ? repoDeps(buildGitHub(this.s, { demoLatencyMs: Math.round(120 * this.speed) }), target) : {};
    const llm = buildLLM(this.s, this.speed, {
      onRetry: (r) => this.orch?.notice(`model call failed (${r.status || "network"}), retry ${r.attempt} in ${(r.waitMs / 1000).toFixed(1)} s`, "warn"),
    });
    const orch = new Orchestrator({
      llm,
      runId: this.runId,
      modelLabel: demo ? "demo recording" : this.s.model,
      config: {
        ...DEFAULT_CONFIG,
        task,
        mode: kind,
        repo: kind === "repo" ? target : undefined,
        notes: $<HTMLTextAreaElement>("#notes").value.trim() || undefined,
        refUrl: kind === "site" ? $<HTMLInputElement>("#ref-url").value.trim() || undefined : undefined,
        gates: { ...this.s.gates },
        budgetUsd: this.s.budgetUsd,
        pricing: demo ? DEMO_PRICING : { input: this.s.priceIn, output: this.s.priceOut },
      },
      fetchRef,
      syntax: __PREVIEW__ ? basicSyntax : undefined,
      deploy: (id, files) => deployToWorker(id, task, files),
      ...repoHooks,
      pace: {
        handoff: (from, to, summary) => this.office.meeting(from, to, summary),
        tickets: (t) => this.office.whiteboard(t),
      },
    });
    $<HTMLTextAreaElement>("#task").value = task;
    $("#run-title").textContent = runTitle(task);
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
      case "changes": if (!$("#files").hidden) this.renderFiles(); break;
      case "pr":
        void this.office.celebrate("ops", `PR #${e.number}`, `PR #${e.number} is open!`);
        break;
      case "done": this.renderResult(); break;
      default: break;
    }
  }

  private renderChrome() {
    const hx = this.onHermes;
    $("#hermes-box").hidden = !hx;
    for (const el of [$("#task"), $("#task-form > .task-row")]) el.hidden = hx;
    $("#task-target").hidden = !!this.watch;
    if (hx) {
      $("#notes-wrap").hidden = true;
      this.renderTarget(false);
      this.hermes.render();
      return;
    }
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
    this.renderTarget(active);
    $("#ref-url").closest("div")!.querySelectorAll<HTMLElement>('[for="ref-url"], #ref-url').forEach((el) => (el.hidden = this.currentKind() === "repo"));
    if (active) $("#notes-wrap").hidden = true;
    $("#task-mode").textContent = this.s.mode === "demo" ? (active ? "Demo run" : "Demo · no key") : active ? "Live run" : `Live · ${this.s.model}`;
    if (!this.orch && this.s.mode === "live" && this.currentKind() === "repo") $("#task-mode").textContent = "Live · opens a PR";
    const label: Record<string, string> = { idle: "ready", running: "working", waiting: "waiting for you", paused: "paused", done: "done", failed: "failed", cancelled: "cancelled", budget: "budget cap hit" };
    $("#mode-chip").innerHTML = `${this.s.mode === "demo" ? "<b>Demo</b> · recorded run" : `<b>Live</b> · ${esc(this.s.model)}`} · ${label[st]}`;
    $("#mode-chip").dataset.status = st;
  }

  // ---------- panel pieces ----------
  private renderSteps(steps: Record<StepId, { state: StepState; pct?: number; note?: string }>) {
    const v = $("#steps"), h = $("#steps-h");
    const repo = !this.onHermes && (this.orch ? this.runKind : this.currentKind()) === "repo";
    const hx = this.onHermes;
    const lbl = (id: StepId, label: string) => (repo && id === "deploy" ? "Open PR" : repo && id === "code" ? "Patch" : hx && id === "review" ? "Verify" : hx && id === "deploy" ? "Ship" : label);
    v.innerHTML = STEPS.map(({ id, label: l0 }) => {
      const label = lbl(id, l0);
      const s = steps[id];
      const stateText = s.note && s.state !== "pending" ? `${s.state === "done" ? "✓ " : ""}<small class="note">${esc(s.note)}</small>` : s.state === "done" ? "✓" : s.state === "active" ? (id === "code" && s.pct !== undefined ? `${s.pct}%` : "working") : s.state;
      const bar = id === "code" && (s.state === "active" || (s.state === "done" && false)) ? `<span class="bar"><i style="width:${s.pct ?? 0}%"></i></span>` : "";
      return `<li class="step ${s.state}" data-step="${id}"><span class="dot"></span><span class="label">${label}</span><span class="state">${stateText}</span>${bar}</li>`;
    }).join("");
    h.innerHTML = STEPS.map(({ id, label: l0 }) => {
      const label = lbl(id, l0) === "Open PR" ? "PR" : lbl(id, l0);
      const s = steps[id];
      const pip = s.state === "active" && id === "code" && s.pct !== undefined ? `${s.pct}%` : "";
      return `<li class="${s.state}"><span class="pip">${pip}</span><span>${label}</span></li>`;
    }).join("");
  }

  private renderLog(log: LogEntry[], startedAt = this.startedAt, emptyHtml?: string) {
    const el = $("#log");
    if (!log.length && emptyHtml) { el.innerHTML = `<li class="empty">${emptyHtml}</li>`; return; }
    if (!log.length) {
      const kind = this.currentKind();
      el.innerHTML = `<li class="empty">${this.s.mode === "demo"
        ? kind === "repo"
          ? "Press <b>Run demo</b> to watch the team fix a bug in a small repo and open a pull request. No key and no GitHub account needed: a mocked GitHub answers, the engine, patches and checks are real."
          : "Press <b>Run demo</b> to watch the team build the Kopi Senja landing page. No key needed: it replays a recorded run through the real engine and checks."
        : kind === "repo" ? "Describe the change, pick a repo and press <b>Run</b>. The team reads the repo, patches it and asks before opening a pull request." : "Describe a small website or tool and press <b>Run</b>."}</li>`;
      return;
    }
    const rows = log.slice(-200).reverse().map((e) => {
      const sec = Math.max(0, Math.floor((e.t - startedAt) / 1000));
      const el = `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}]`;
      const who = e.agent === "system" ? "" : `<b>${esc(e.name ?? ROLE_INFO[e.agent].name)}</b> `;
      const stamp = sec >= 3600 ? `[${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}]` : el;
      return `<li class="${e.level ?? "info"}"><time>${stamp}</time><span>${who}${esc(e.text)}</span></li>`;
    });
    el.innerHTML = rows.join("");
  }

  private renderCost(usd: number, tokens: number, by: Record<Role, { tokens: number; usd: number }> | null, opts?: { meta?: string; names?: Partial<Record<Role, string>>; note?: string }) {
    if (opts) {
      $("#cost-usd").textContent = usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
      $<HTMLElement>("#cost-fill").style.width = `${Math.min(100, usd * 100)}%`;
      $("#cost-meta").textContent = opts.meta ?? "";
      $("#cost").classList.remove("over");
      $("#cost-break").innerHTML = (by
        ? ROLES.filter((r) => by[r].tokens > 0).map((r) => `<span><span>${esc(opts.names?.[r] ?? ROLE_INFO[r].name)}</span><span>${by[r].tokens.toLocaleString("en-US")} tok · $${by[r].usd.toFixed(4)}</span></span>`).join("") || `<span>No spend yet.</span>`
        : `<span>No spend yet.</span>`) + (opts.note ? `<span><span>${esc(opts.note)}</span></span>` : "");
      return;
    }
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
    return `<pre class="diff">${d.map((l) => `<span class="${l.type}">${l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}${esc(l.text)}</span>`).join("")}</pre>`;
  }

  private showGate(g: GateRequest) {
    const items = g.items?.length ? `<details ${g.kind === "pr" ? "open" : ""}><summary>${g.kind === "plan" ? "Tickets" : g.kind === "deploy" || g.kind === "pr" ? "Files" : "Details"} (${g.items.length})</summary><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></details>` : "";
    const body = g.kind === "question" || g.kind === "delete" ? `<p>${esc(g.body)}</p>` : g.kind === "pr" ? `<p class="pr-line">${esc(g.body)}</p>` : "";
    const card = $("#approval");
    card.innerHTML = `<p class="approval-title" id="gate-title">${this.titleHTML(g)}</p>${body}${items}${g.kind === "deploy" || g.kind === "pr" ? this.diffHTML(g.diff) : ""}
      <div class="actions"><button class="btn btn-primary" data-act="approve">${g.kind === "pr" ? "Open PR" : "Approve"}</button><button class="btn" data-act="reject">Reject</button></div>
      <div class="more"><button class="link-btn" data-act="toggle-comment">${g.kind === "question" ? "Answer" : "Comment"}</button></div>
      <div class="comment" hidden><input aria-label="Comment for the agent" placeholder="${g.kind === "question" ? "Your answer…" : `Feedback for ${ROLE_INFO[g.agent].name} (Reject sends it back)`}" maxlength="1000"><button class="btn btn-sm" data-act="comment">Send</button></div>`;
    card.hidden = false;
    card.dataset.gate = g.id;
    this.bindGate(card, g);
    // phone: full-screen approval like the mockup
    const m = $("#mobile-approval");
    m.innerHTML = `<div class="ma-card"><img alt="${ROLE_INFO[g.agent].name}" src="${this.portraits[g.agent]}"><h2 id="ma-title">${this.titleHTML(g)}</h2>${body}${this.diffHTML(g.diff) || (g.items?.length ? `<ul>${g.items.slice(0, 5).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "")}
      <div class="actions"><button class="btn btn-primary" data-act="approve">${g.kind === "pr" ? "Open PR" : "Approve"}</button><button class="btn" data-act="reject">Reject</button></div>
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
    if (o.mode === "repo") {
      const pr = o.pr;
      const n = o.repo?.changes().length ?? 0;
      el.innerHTML = `<h3>${pr ? `Pull request #${pr.number} is open` : n ? "Changes are ready" : "No changes"}</h3>
        <p>${esc(o.summary)}.${pr ? "" : n ? " No PR was opened; download the patch to apply it yourself." : ""}</p>
        ${pr ? `<p class="pr-line">${esc(pr.branch)} → ${esc(o.config.repo?.branch ?? "")}</p>` : ""}
        <div class="row">${pr ? `<a class="btn btn-primary btn-sm" data-r="pr" href="${esc(pr.url)}" target="_blank" rel="noopener">Open PR #${pr.number} ↗</a>` : ""}${n ? `<button class="btn btn-sm" data-r="changes">Changes &amp; diff</button><button class="btn btn-sm" data-r="patch">Download .patch</button>` : ""}</div>`;
      el.hidden = false;
      el.querySelector('[data-r="changes"]')?.addEventListener("click", () => { this.filesState.tab = "changes"; this.open("files"); });
      el.querySelector('[data-r="patch"]')?.addEventListener("click", () => this.downloadPatch());
      return;
    }
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
    const hs = this.onHermes ? this.hermes.session : null;
    const st = hs ? hs.agents[r] : this.orch?.agents[r];
    const activity = st ? { idle: "idle", working: "working", meeting: "in a handoff", whiteboard: "at the whiteboard", coffee: "on a coffee break", waiting: "waiting for your approval" }[st.activity] : "idle";
    const log = st?.log.slice(-6).reverse() ?? [];
    const files = st?.filesTouched ?? [];
    const name = hs ? hs.agents[r].name : ROLE_INFO[r].name;
    const sub = hs && name !== ROLE_INFO[r].name ? `Hermes subagent at the ${ROLE_INFO[r].name} desk` : ROLE_INFO[r].title;
    el.innerHTML = `<header><img alt="" src="${this.portraits[r]}"><div><h3>${esc(name)}</h3><div class="sub">${esc(sub)} · ${activity}</div></div><button class="link-btn x" aria-label="Close">Close</button></header>
      <p class="thought">${st?.thought ? esc(st.thought) : this.onHermes ? "Nothing yet. This desk lights up when Hermes does this kind of work." : "No thoughts yet. Start a run."}</p>
      <h4>Recent log</h4><ul>${log.length ? log.map((l) => `<li>${esc(l)}</li>`).join("") : "<li>—</li>"}</ul>
      <h4>Files touched</h4><ul class="files">${files.length ? files.map((f) => `<li data-f="${esc(f)}">${esc(f)}</li>`).join("") : "<li>—</li>"}</ul>
      <h4>Spend</h4><ul><li>${(st?.tokens ?? 0).toLocaleString("en-US")} tokens · $${(st?.cost ?? 0).toFixed(3)}</li></ul>`;
    el.hidden = false;
    el.querySelector(".x")!.addEventListener("click", () => this.selectAgent(null));
    if (!hs) el.querySelectorAll<HTMLElement>("[data-f]").forEach((li) => li.addEventListener("click", () => { this.filesState = { ...this.filesState, tab: "files", path: li.dataset.f!, version: -1 }; this.open("files"); }));
  }

  // ---------- overlays ----------
  private open(which: Overlay) {
    for (const id of OVERLAYS) if (id !== which) $(`#${id}`).hidden = true;
    if (which === "files") this.renderFiles();
    if (which === "settings") this.renderSettings();
    if (which === "history") this.renderHistory();
    if (which === "github") this.renderGitHub();
    if (which === "hermes") this.hermes.renderSetup();
    if (which === "insights") this.insights.renderOverlay();
    const el = $(`#${which}`);
    el.hidden = false;
    el.querySelector<HTMLElement>("button, input, select")?.focus();
  }
  private close(id: string) { $(`#${id}`).hidden = true; }

  private head(title: string, extra = "") {
    return `<div class="ov-head"><h2>${title}</h2>${extra}<span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div>`;
  }

  private currentChanges(): ChangeView[] | null {
    if (this.viewing) return this.viewing.kind === "repo" ? this.viewing.changes ?? [] : null;
    const kind = this.orch ? this.runKind : this.currentKind();
    if (kind !== "repo") return null;
    const fs = this.orch?.repo;
    if (!fs) return [];
    return fs.changes().map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed, diff: fs.diff(c.path) }));
  }

  private downloadPatch() {
    const ch = this.currentChanges() ?? [];
    const text = ch.map((c) => c.diff).join("\n") + "\n";
    const name = slug(this.viewing?.task ?? $<HTMLTextAreaElement>("#task").value) || "changes";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/x-diff" }));
    a.download = `${name}.patch`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  private changesBody(changes: ChangeView[]): string {
    if (!changes.length) return `<div class="files-empty">No changes yet. Patches the Coder makes show up here as a unified diff against the base branch.</div>`;
    const fs = this.filesState;
    if (!changes.some((c) => c.path === fs.change)) fs.change = changes[0].path;
    const cur = changes.find((c) => c.path === fs.change)!;
    const mark = { added: "A", modified: "M", deleted: "D" } as const;
    const tree = changes.map((c) => `<button data-change="${esc(c.path)}" aria-current="${c.path === fs.change}" title="${esc(c.path)}"><span class="st st-${c.status}">${mark[c.status]}</span>${esc(c.path)}</button>`).join("");
    const code = cur.diff.split("\n").map((l) => {
      if (/^(diff --git|---|\+\+\+|new file mode|deleted file mode)/.test(l)) return `<span class="ln meta" data-n="">${esc(l)}</span>`;
      if (l.startsWith("@@")) return `<span class="ln hunk" data-n="">${esc(l)}</span>`;
      const t = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
      return `<span class="ln ${t}" data-n="${t === "add" ? "+" : t === "del" ? "−" : ""}">${esc(l.slice(1))}</span>`;
    }).join("");
    const total = changes.reduce((n, c) => ({ a: n.a + c.added, r: n.r + c.removed }), { a: 0, r: 0 });
    return `<div class="files-body"><nav class="tree" aria-label="Changed files"><div class="dir">${changes.length} changed · +${total.a} −${total.r}</div>${tree}</nav><div class="viewer">
      <div class="viewer-bar"><b>${esc(cur.path)}</b><span class="cost-meta">${cur.status} · +${cur.added} −${cur.removed} vs base</span></div>
      <pre class="code" data-code data-diff-view>${code}</pre></div></div>`;
  }

  private currentFiles(): { files: Record<string, string>; snapshots: Snapshot[]; url: string; local: boolean } {
    if (this.viewing) return { files: this.viewing.files, snapshots: this.viewing.snapshots, url: this.viewing.url, local: !this.viewing.url };
    return { files: this.files, snapshots: this.snapshots, url: this.deployed?.url ?? "", local: this.deployed?.local ?? true };
  }

  private renderFiles() {
    const el = $("#files");
    const { files, snapshots, url, local } = this.currentFiles();
    const prUrl = this.viewing ? this.viewing.pr?.url : this.orch?.pr?.url;
    const fs = this.filesState;
    const paths = Object.keys(files).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
    if (!paths.includes(fs.path) && paths.length) fs.path = paths[0];
    const changes = this.currentChanges();
    if (changes && fs.tab === "preview") fs.tab = "changes";
    if (!changes && fs.tab === "changes") fs.tab = "files";
    const tabs = changes
      ? `<div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="changes" aria-selected="${fs.tab === "changes"}">Changes</button><button class="tab" role="tab" data-tab="files" aria-selected="${fs.tab === "files"}">Files</button></div>`
      : `<div class="tabs" role="tablist"><button class="tab" role="tab" data-tab="files" aria-selected="${fs.tab === "files"}">Files</button><button class="tab" role="tab" data-tab="preview" aria-selected="${fs.tab === "preview"}">Preview</button></div>`;
    const zip = changes ? (changes.length ? `<button class="btn btn-sm" data-patch>Download .patch</button>` : "") : paths.length ? `<button class="btn btn-sm" data-zip>Download ZIP</button>` : "";
    let body: string;
    if (fs.tab === "changes" && changes) body = this.changesBody(changes);
    else if (fs.tab === "files") {
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
    const extLink = changes ? (prUrl ? `<a class="btn btn-sm" href="${esc(prUrl)}" target="_blank" rel="noopener">PR ↗</a>` : "") : url && !local ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener">New tab ↗</a>` : "";
    el.innerHTML = this.head(changes ? "Changes" : "Files", tabs + zip + extLink) + body;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("files"));
    el.querySelector("[data-zip]")?.addEventListener("click", () => this.downloadZip());
    el.querySelector("[data-patch]")?.addEventListener("click", () => this.downloadPatch());
    el.querySelectorAll<HTMLElement>("[data-change]").forEach((b) => b.addEventListener("click", () => { fs.change = b.dataset.change!; this.renderFiles(); }));
    el.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => { fs.tab = b.dataset.tab as "files" | "preview" | "changes"; this.renderFiles(); }));
    el.querySelectorAll<HTMLElement>("[data-path]").forEach((b) => b.addEventListener("click", () => { fs.path = b.dataset.path!; fs.version = -1; this.renderFiles(); }));
    el.querySelector<HTMLSelectElement>("[data-version]")?.addEventListener("change", (e) => { fs.version = Number((e.target as HTMLSelectElement).value); this.renderFiles(); });
    el.querySelector<HTMLInputElement>("[data-diff]")?.addEventListener("change", (e) => { fs.diff = (e.target as HTMLInputElement).checked; this.renderFiles(); });
  }

  private downloadZip() {
    if (this.currentChanges()) { this.downloadPatch(); return; }
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
        <small>Demo replays recorded runs (a landing page, and a bug fix that opens a PR on a mocked GitHub) through the real engine. Live runs your own task on your own model.</small></div>
      <h3>Model</h3>
      <label class="field"><span>Provider preset</span><select name="preset">${PRESETS.map((p) => `<option value="${p.id}" ${p.id === s.preset ? "selected" : ""}>${p.label}</option>`).join("")}<option value="custom" ${s.preset === "custom" ? "selected" : ""}>Custom (OpenAI-compatible)</option></select></label>
      <label class="field"><span>Base URL</span><input name="baseUrl" value="${esc(s.baseUrl)}" spellcheck="false"></label>
      <label class="field"><span>Model</span><input name="model" value="${esc(s.model)}" spellcheck="false"><small data-free>${this.freeHint(s.preset)}</small></label>
      <label class="field"><span>API key</span><input name="apiKey" type="password" value="${esc(key)}" autocomplete="off" spellcheck="false" placeholder="sk-…"><small>Kept in this browser only (session storage unless you tick remember). Sent per request to the provider, directly or through the stateless Worker proxy. Never stored server-side, never logged.</small></label>
      <label class="check"><input type="checkbox" name="rememberKey" ${s.rememberKey ? "checked" : ""}> Remember the key on this device</label>
      <label class="field"><span>Route</span><select name="route"><option value="proxy" ${s.route === "proxy" ? "selected" : ""}>Through the Worker proxy (no CORS issues)</option><option value="direct" ${s.route === "direct" ? "selected" : ""}>Direct from the browser (provider must allow CORS)</option></select></label>
      <label class="field"><span>Reply format</span><select name="output">
        <option value="auto" ${s.output === "auto" ? "selected" : ""}>Auto: tool calling → JSON mode → plain prompt</option>
        <option value="tools" ${s.output === "tools" ? "selected" : ""}>Native tool calling</option>
        <option value="json" ${s.output === "json" ? "selected" : ""}>JSON mode</option>
        <option value="prompt" ${s.output === "prompt" ? "selected" : ""}>Plain prompt (strict JSON + repair)</option></select>
        <small>Overtime steps down automatically when a provider refuses a format. Almost-JSON replies are repaired before the agent is asked again.</small></label>
      <label class="check"><input type="checkbox" name="stream" ${s.stream ? "checked" : ""}> Stream replies</label>
      <div class="task-row"><button type="button" class="btn btn-sm" data-test>Test connection</button><span class="conn-result" data-conn role="status"></span></div>
      <div class="row2"><label class="field"><span>$ / 1M input tokens</span><input name="priceIn" type="number" step="any" min="0" value="${s.priceIn}"></label><label class="field"><span>$ / 1M output tokens</span><input name="priceOut" type="number" step="any" min="0" value="${s.priceOut}"></label></div>
      <label class="field"><span>Budget cap per run (USD)</span><input name="budgetUsd" type="number" step="any" min="0.01" value="${s.budgetUsd}"><small>The run stops before it spends more than this.</small></label>
      <h3>Approval gates</h3>
      <label class="check"><input type="checkbox" name="g_plan" ${s.gates.plan ? "checked" : ""}> Approve the PM's plan</label>
      <label class="check"><input type="checkbox" name="g_review" ${s.gates.review ? "checked" : ""}> Ask me when the Reviewer finds failures</label>
      <label class="check"><input type="checkbox" name="g_deploy" ${s.gates.deploy ? "checked" : ""}> Approve before deploy / push</label>
      <h3>GitHub (repo mode)</h3>
      <div class="task-row"><button type="button" class="btn btn-sm" data-gh>${secrets.ghToken(s) ? `Connected${s.ghLogin ? ` as @${esc(s.ghLogin)}` : ""} · change` : "Connect GitHub…"}</button><small>${s.ghRepo ? `${esc(s.ghRepo)} @ ${esc(s.ghBranch)}` : "No repo picked"}</small></div>
      <h3>Demo</h3>
      <label class="field"><span>Demo speed</span><select name="demoSpeed"><option value="1" ${s.demoSpeed === 1 ? "selected" : ""}>Normal</option><option value="0.5" ${s.demoSpeed === 0.5 ? "selected" : ""}>Fast</option><option value="0.25" ${s.demoSpeed === 0.25 ? "selected" : ""}>Very fast</option></select></label>
      <div class="task-row"><button type="button" class="btn btn-ghost" data-clear>Forget keys</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-save>Save</button></div>
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
      el.querySelector<HTMLElement>("[data-free]")!.innerHTML = this.freeHint(p.id);
    });
    el.querySelector("[data-clear]")!.addEventListener("click", () => { secrets.setApiKey(this.s, ""); secrets.setGhToken(this.s, ""); this.renderSettings(); this.renderChrome(); this.toast("Keys forgotten."); });
    el.querySelector("[data-gh]")!.addEventListener("click", () => this.open("github"));
    el.querySelector("[data-free]")?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-use-free]");
      if (!b) return;
      (f.elements.namedItem("model") as HTMLInputElement).value = b.dataset.useFree!;
      (f.elements.namedItem("priceIn") as HTMLInputElement).value = "0";
      (f.elements.namedItem("priceOut") as HTMLInputElement).value = "0";
    });
    el.querySelector("[data-test]")!.addEventListener("click", async () => {
      const out = el.querySelector<HTMLElement>("[data-conn]")!;
      const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
      out.className = "conn-result";
      out.textContent = "Testing…";
      const r = await testConnection({ baseUrl: v("baseUrl"), model: v("model"), apiKey: v("apiKey"), route: v("route") as Settings["route"], jsonMode: false });
      out.className = `conn-result ${r.ok ? "ok" : "bad"}`;
      out.textContent = r.ok ? `OK · ${r.model} · ${r.latencyMs} ms` : `Failed: ${r.error}`;
    });
    f.addEventListener("submit", (e) => e.preventDefault());
    el.querySelector("[data-save]")!.addEventListener("click", () => {
      const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
      const c = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).checked;
      const next: Settings = {
        ...this.s, mode, preset: v("preset"), baseUrl: v("baseUrl") || this.s.baseUrl, model: v("model") || this.s.model, route: v("route") as Settings["route"],
        output: v("output") as Settings["output"], stream: c("stream"), jsonMode: v("output") !== "prompt", rememberKey: c("rememberKey"), priceIn: Math.max(0, Number(v("priceIn")) || 0), priceOut: Math.max(0, Number(v("priceOut")) || 0),
        budgetUsd: Math.max(0.01, Number(v("budgetUsd")) || 0.5), gates: { plan: c("g_plan"), review: c("g_review"), deploy: c("g_deploy") },
        demoSpeed: Number(v("demoSpeed")) || 1,
      };
      const modeChanged = next.mode !== this.s.mode;
      this.s = next;
      if (!new URLSearchParams(location.search).get("speed")) this.speed = next.demoSpeed;
      saveSettings(next);
      secrets.setApiKey(next, v("apiKey"));
      if (modeChanged && !this.orch) { $<HTMLTextAreaElement>("#task").value = this.defaultTask(); $("#run-title").textContent = runTitle(this.defaultTask() || "New task"); }
      this.close("settings");
      if (!this.orch) { this.renderLog([]); this.renderCost(0, 0, null); }
      this.renderChrome();
    });
  }

  private freeHint(preset: string) {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p?.freeModel) return "";
    return `Free option: <button type="button" class="link-btn" data-use-free="${esc(p.freeModel)}">${esc(p.freeModel)}</button> (routes to a free model that supports tool calling; slower and rate-limited)`;
  }

  // ---------- GitHub connect ----------
  private ghClient(token = secrets.ghToken(this.s)) {
    return new GitHubClient(new PatAuth(token), { route: this.s.ghRoute });
  }

  private ghErr(e: unknown) {
    return e instanceof GitHubError ? e.message : `Could not reach GitHub: ${(e as Error).message}`;
  }

  private async ghLoadRepos(token: string) {
    const g = this.gh;
    g.busy = true; g.error = ""; this.renderGitHub();
    try {
      const c = this.ghClient(token);
      const me = await c.viewer();
      const repos = await c.listRepos();
      g.login = me.login;
      g.repos = repos;
      g.step = "repos";
      this.s.ghLogin = me.login;
      saveSettings(this.s);
      if (this.s.ghRepo && repos.some((r) => r.full_name === this.s.ghRepo)) await this.ghPick(this.s.ghRepo, false);
    } catch (e) {
      g.error = this.ghErr(e);
      g.step = "token";
    } finally {
      g.busy = false;
      this.renderGitHub();
    }
  }

  private async ghPick(repo: string, render = true) {
    const g = this.gh;
    g.repo = repo; g.branches = []; g.error = ""; g.busy = true;
    if (render) this.renderGitHub();
    try {
      const info = g.repos.find((r) => r.full_name === repo);
      g.branches = await this.ghClient().listBranches(repo);
      const keep = repo === this.s.ghRepo && g.branches.some((b) => b.name === this.s.ghBranch) ? this.s.ghBranch : info?.default_branch;
      g.branch = keep && g.branches.some((b) => b.name === keep) ? keep : g.branches[0]?.name ?? "";
      if (info && info.permissions && info.permissions.push === false) g.error = "This token cannot push to this repo; opening a PR will fail. Pick another repo or widen the token.";
    } catch (e) {
      g.error = this.ghErr(e);
    } finally {
      g.busy = false;
      if (render) this.renderGitHub();
    }
  }

  private renderGitHub() {
    const el = $("#github");
    const g = this.gh;
    const token = secrets.ghToken(this.s);
    if (token && g.step === "token" && !g.busy && !g.error && !g.repos.length) { void this.ghLoadRepos(token); return; }
    const err = g.error ? `<div class="err" role="alert">${esc(g.error)}</div>` : "";
    let body: string;
    if (g.step === "token" || !token) {
      body = `<div class="gh">
        <p>Overtime opens pull requests on your repos with a <b>fine-grained personal access token</b>. It stays in this browser and goes to GitHub on each request through Overtime's stateless proxy, which never stores or logs it.</p>
        <h3>Token settings</h3>
        <ul class="scopes"><li>Repository access: <b>only select repositories</b></li><li>Contents: <b>Read and write</b></li><li>Pull requests: <b>Read and write</b></li><li>Metadata: Read (added automatically)</li></ul>
        <p><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a token on GitHub ↗</a></p>
        <label class="field"><span>Token</span><input name="gh-token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…" value=""></label>
        <label class="check"><input type="checkbox" name="gh-remember" ${this.s.ghRemember ? "checked" : ""}> Remember on this device (otherwise it is forgotten when the tab closes)</label>
        <label class="field"><span>Route</span><select name="gh-route"><option value="proxy" ${this.s.ghRoute === "proxy" ? "selected" : ""}>Through the Overtime Worker (recommended)</option><option value="direct" ${this.s.ghRoute === "direct" ? "selected" : ""}>Direct to api.github.com</option></select></label>
        ${err}
        <div class="task-row"><span class="spacer"></span><button type="button" class="btn btn-primary" data-connect ${g.busy ? "disabled" : ""}>${g.busy ? "Connecting…" : "Connect"}</button></div>
        <p>Overtime only ever creates a new <code>overtime/…</code> branch, one commit and one pull request. It never pushes to your base branch, never force-pushes and never merges.</p>
      </div>`;
    } else {
      const q = g.filter.toLowerCase();
      const list = g.repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)).slice(0, 60);
      body = `<div class="gh">
        <div class="who"><span>Connected as <b>@${esc(g.login)}</b></span><span class="spacer"></span><button type="button" class="link-btn" data-disconnect>Disconnect</button></div>
        <label class="field"><span>Repository</span><input name="gh-filter" placeholder="Filter ${g.repos.length} repos…" value="${esc(g.filter)}" spellcheck="false"></label>
        <div class="repo-list" role="listbox" aria-label="Repositories">${list.length ? list.map((r) => `<button type="button" data-repo="${esc(r.full_name)}" aria-pressed="${r.full_name === g.repo}"><b>${esc(r.full_name)}</b><span>${r.private ? "private" : "public"} · default ${esc(r.default_branch)}${r.description ? ` · ${esc(r.description.slice(0, 60))}` : ""}</span></button>`).join("") : `<p>No repos match. A fine-grained token only sees the repos you selected when you created it.</p>`}</div>
        ${g.repo ? `<label class="field"><span>Base branch for the PR</span><select name="gh-branch" ${g.busy ? "disabled" : ""}>${g.branches.map((b) => `<option value="${esc(b.name)}" ${b.name === g.branch ? "selected" : ""}>${esc(b.name)}${b.protected ? " (protected)" : ""}</option>`).join("")}</select><small>The PR targets this branch. Protected is fine: Overtime never pushes to it.</small></label>` : ""}
        ${err}
        <div class="task-row"><span class="spacer"></span><button type="button" class="btn btn-primary" data-use ${g.repo && g.branch && !g.busy ? "" : "disabled"}>Use this repo</button></div>
      </div>`;
    }
    el.innerHTML = this.head("GitHub") + body;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("github"));
    el.querySelector("[data-connect]")?.addEventListener("click", () => {
      const v = el.querySelector<HTMLInputElement>('[name="gh-token"]')!.value.trim();
      if (!v) { g.error = "Paste a token first."; this.renderGitHub(); return; }
      this.s.ghRemember = el.querySelector<HTMLInputElement>('[name="gh-remember"]')!.checked;
      this.s.ghRoute = el.querySelector<HTMLSelectElement>('[name="gh-route"]')!.value as Settings["ghRoute"];
      saveSettings(this.s);
      secrets.setGhToken(this.s, v);
      void this.ghLoadRepos(v);
    });
    el.querySelector("[data-disconnect]")?.addEventListener("click", () => {
      secrets.setGhToken(this.s, "");
      Object.assign(this.gh, { step: "token", login: "", repos: [], branches: [], repo: "", branch: "", filter: "", error: "" });
      Object.assign(this.s, { ghRepo: "", ghBranch: "", ghLogin: "" });
      saveSettings(this.s);
      this.renderGitHub();
      this.renderChrome();
    });
    const filter = el.querySelector<HTMLInputElement>('[name="gh-filter"]');
    filter?.addEventListener("input", () => {
      g.filter = filter.value;
      const pos = filter.selectionStart;
      this.renderGitHub();
      const f2 = el.querySelector<HTMLInputElement>('[name="gh-filter"]')!;
      f2.focus();
      f2.setSelectionRange(pos, pos);
    });
    el.querySelectorAll<HTMLElement>("[data-repo]").forEach((b) => b.addEventListener("click", () => void this.ghPick(b.dataset.repo!)));
    el.querySelector<HTMLSelectElement>('[name="gh-branch"]')?.addEventListener("change", (e) => { g.branch = (e.target as HTMLSelectElement).value; });
    el.querySelector("[data-use]")?.addEventListener("click", () => {
      Object.assign(this.s, { ghRepo: g.repo, ghBranch: g.branch, taskKind: "repo" as TaskMode });
      saveSettings(this.s);
      this.close("github");
      this.renderChrome();
      this.toast(`Repo set: ${g.repo} @ ${g.branch}`);
    });
  }

  private saveHistory(o: Orchestrator) {
    const list = store.getJSON<HistoryItem[]>(HISTORY_KEY, []);
    const fs = o.repo;
    const changes = fs ? fs.changes().map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed, diff: fs.diff(c.path).slice(0, 200_000) })) : undefined;
    const item: HistoryItem = { id: this.runId, task: o.config.task, status: o.status, at: this.startedAt, usd: o.usage.usd, tokens: o.usage.tokens, mode: this.s.mode, files: { ...o.files }, snapshots: o.snapshots, url: this.deployed && !this.deployed.local ? this.deployed.url : "", log: o.log.slice(-80), kind: o.mode, repo: o.config.repo?.repo, pr: o.pr, changes };
    store.setJSON(HISTORY_KEY, [item, ...list.filter((x) => x.id !== item.id)].slice(0, 8));
  }

  private renderHistory() {
    const el = $("#history");
    const list = store.getJSON<HistoryItem[]>(HISTORY_KEY, []);
    el.innerHTML = this.head("History") + `<div class="history">${list.length ? list.map((h, i) => `<button class="run" data-i="${i}"><b>${esc(h.task)}</b><span class="meta">${new Date(h.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${h.status} · ${h.kind === "repo" ? `${esc(h.repo ?? "")}${h.pr ? ` · PR #${h.pr.number}` : ""} · ${(h.changes ?? []).length} changed` : `${Object.keys(h.files).length} files`} · $${h.usd.toFixed(3)} · ${h.mode}</span></button>`).join("") : `<p class="files-empty">Finished runs are kept here (last 8, in this browser).</p>`}</div>`;
    el.querySelector("[data-close]")!.addEventListener("click", () => this.close("history"));
    el.querySelectorAll<HTMLElement>("[data-i]").forEach((b) => b.addEventListener("click", () => {
      this.viewing = list[Number(b.dataset.i)];
      this.filesState = { tab: this.viewing.kind === "repo" ? "changes" : "files", path: "index.html", version: -1, diff: false, change: "" };
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
