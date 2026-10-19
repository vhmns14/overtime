// Insights UI: replay timelapse (office + replay bar + GIF/WebM/MP4 export), the timeline with
// filters, the session summary card (PNG / markdown), the cost dashboard with budgets, and stuck
// detection (office "?" + banner). Lives beside the Hermes controller and only reads from it.

import { ROLES, ROLE_INFO, type Role } from "../engine/types";
import { store } from "../engine/storage";
import { OpenAICompatibleLLM } from "../engine/llm";
import type { Office } from "../office/scene";
import type { ExtEvent, EventData } from "../ext/schema";
import { applyEvent, newOffice, type OfficeState, type SessionView } from "../ext/office-state";
import type { HermesController } from "../app/hermes";
import { llmSettings, secrets, type Settings } from "../app/settings";
import { esc } from "../app/deploy";
import { sessionEvents, sessionIds, attribute } from "./sessions";
import { costByDay, costByModel, costBySession, emptyTokens, llmCost, sessionStats, sessionTitles, spendNow, type SessionStats } from "./aggregate";
import { buildSchedule, exportSpeed, fmtClock, realLength, ReplayClock, SPEEDS, type Schedule } from "./replay";
import { countByFilter, filterTimeline, FILTERS, toTimeline, type Filter, type TimelineItem } from "./timeline";
import { DEFAULT_STUCK, detectStuck, normalizeThresholds, turnState, type StuckReason, type StuckThresholds } from "./stuck";
import { budgetStatus, normalizeBudget, DEFAULT_BUDGET, type BudgetConfig, type BudgetStatus } from "./budget";
import { emitSignal, onSignal, SignalGate, budgetKey, stuckKey, type InsightSignal } from "./signals";
import { fmtDuration, fmtTokens, fmtUsd, headline, llmSummaryPrompt, STATUS_LABEL, summaryMarkdown, whatWasDone } from "./summary";
import { drawSummaryCard, canvasBlob } from "./card-png";
import { FrameComposer, gifRecorder, videoRecorder, pickMime, download, fmtBytes, type Recorder, type VideoKind } from "./export";
import { barChart, hBars, stackBar } from "./charts";
import { sampleHistory } from "./sample";
import { SceneDriver } from "./driver";
import "./insights.css";

export interface InsightsHost {
  office: Office;
  officeEl: HTMLElement;
  hermes: HermesController;
  renderSteps(steps: SessionView["steps"]): void;
  renderLog(log: SessionView["log"], startedAt: number, empty?: string): void;
  renderCost(usd: number, tokens: number, by: Record<Role, { tokens: number; usd: number }> | null, opts?: { meta?: string; names?: Partial<Record<Role, string>>; note?: string }): void;
  setChip(html: string, status: string): void;
  toast(msg: string): void;
  openOverlay(): void;
  closeOverlay(): void;
  isHermes(): boolean;
  settings(): Settings;
  /** the office this browser can read (owner or viewer), for the insights endpoint */
  officeAccess(): { id: string; token: string } | null;
}

type Tab = "timeline" | "summary" | "costs" | "alerts";
type ExportKind = "gif" | VideoKind;

interface Replay {
  session: string;
  title: string;
  events: ExtEvent[];
  schedule: Schedule;
  clock: ReplayClock;
  st: OfficeState;
  driver: SceneDriver;
  raf: number;
  last: number;
  lastPanel: number;
  speedBefore: number;
  exporting: { kind: ExportKind; rec: Recorder; chosen: number } | null;
  wasPlaying: boolean;
}

const CFG_KEY = "overtime:insights:v1";
const SIG_KEY = "overtime:insights-signals:v1";
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const FILTER_LABEL: Record<Filter, string> = { tools: "Tools", errors: "Errors", llm: "LLM", files: "Files", subagents: "Subagents", approvals: "Approvals" };
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
const ICON_PREV = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1.5" width="2" height="9" fill="currentColor"/><path d="M11 1.5v9L4 6z" fill="currentColor"/></svg>`;
const ICON_NEXT = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="9" y="1.5" width="2" height="9" fill="currentColor"/><path d="M1 1.5v9L8 6z" fill="currentColor"/></svg>`;
const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ICON: Record<string, string> = { tools: "▸", errors: "✗", llm: "◆", files: "✎", subagents: "⇄", approvals: "!", session: "●", messages: "❝", plan: "☰" };

export class InsightsController {
  tab: Tab = "timeline";
  rp: Replay | null = null;
  private filters = new Set<Filter>();
  private query = "";
  private selected: number | null = null;
  private tlSession: string | null = null;
  private tlLimit = 300;
  private sumSession: string | null = null;
  private ai: Record<string, string> = {};
  private aiBusy = false;
  private speed = 2;
  private exportOpts = { kind: "gif" as ExportKind, caption: true, corner: true };
  private exportResult: { url: string; name: string; size: number; kind: ExportKind; gifPreview: boolean } | null = null;
  private exportStatus = "";
  budget: BudgetConfig;
  stuck: StuckThresholds;
  private gate: SignalGate;
  private dismissed = new Set<string>();
  private stuckNow: { session: string; reasons: StuckReason[]; role: Role | null } | null = null;
  private budgetNow: BudgetStatus | null = null;
  private costMode: "usd" | "tokens" = "usd";
  private costDays = 14;
  private remote: { key: string; events: ExtEvent[]; truncated: boolean; at: number } | null = null;
  private remoteBusy = false;
  private checkTimer = 0;
  private idleTimer = 0;
  recentSignals: InsightSignal[] = [];
  private els!: { banners: HTMLElement; card: HTMLElement; bar: HTMLElement; open: HTMLButtonElement; overlay: HTMLElement };

  constructor(private host: InsightsHost) {
    const cfg = store.getJSON<{ budget?: Partial<BudgetConfig>; stuck?: Partial<StuckThresholds>; speed?: number } | null>(CFG_KEY, null) ?? {};
    this.budget = normalizeBudget(cfg.budget ?? DEFAULT_BUDGET);
    this.stuck = normalizeThresholds(cfg.stuck ?? DEFAULT_STUCK);
    if (cfg.speed && (SPEEDS as readonly number[]).includes(cfg.speed)) this.speed = cfg.speed;
    this.gate = new SignalGate(store.getJSON<string[]>(SIG_KEY, []), (keys) => store.setJSON(SIG_KEY, keys.filter((k) => k.startsWith("budget:"))));
    onSignal((s) => { this.recentSignals.unshift(s); this.recentSignals.length = Math.min(this.recentSignals.length, 8); });
  }

  // ---------- mount ----------
  mount() {
    const panel = $("#panel");
    const banners = document.createElement("div");
    banners.id = "ins-banners";
    banners.className = "ins-banners";
    banners.setAttribute("aria-live", "polite");
    panel.insertBefore(banners, $("#steps"));
    const card = document.createElement("div");
    card.id = "ins-card";
    card.className = "ins-card";
    card.hidden = true;
    panel.insertBefore(card, $("#approval"));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "rp-open";
    open.textContent = "▶ Replay";
    open.hidden = true;
    open.setAttribute("aria-label", "Replay this session");
    open.addEventListener("click", () => { const s = this.host.hermes.shown; if (s) this.enterReplay(s, { play: true }); });
    const bar = document.createElement("div");
    bar.className = "rp-bar";
    bar.id = "replay-bar";
    bar.hidden = true;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Replay controls");
    this.host.officeEl.append(open, bar);
    this.els = { banners, card, bar, open, overlay: $("#insights") };
    // the replay bar makes room for the sheet while it is open (desktop)
    new MutationObserver(() => document.body.classList.toggle("ins-open", !this.els.overlay.hidden)).observe(this.els.overlay, { attributes: true, attributeFilter: ["hidden"] });
    this.host.hermes.listeners.add((e, session) => this.onHermesEvent(e, session));
    this.idleTimer = window.setInterval(() => this.check(), 15_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.check(); });
  }

  /** The surface changed (Hermes ↔ team, demo, watch): leave replay, clear everything shown. */
  onSurface() {
    this.exitReplay(false);
    this.stuckNow = null;
    this.budgetNow = null;
    this.remote = null;
    for (const r of ROLES) this.host.office.setStuck(r, false);
    this.renderPanelBits();
  }

  private save() { store.setJSON(CFG_KEY, { budget: this.budget, stuck: this.stuck, speed: this.speed }); }

  // ---------- live events ----------
  private onHermesEvent(e: ExtEvent | null, _session: string | null) {
    if (!e) { this.exitReplay(false); this.stuckNow = null; this.renderPanelBits(); return; }
    clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.check(), 120);
  }

  private get onHermes() { return this.host.isHermes(); }

  /** Stuck detection, budget and the end-of-session card for what the office shows. */
  check() {
    if (!this.onHermes) { this.renderPanelBits(); return; }
    if (!this.rp) this.checkStuck(this.host.hermes.shown, sessionEvents(this.host.hermes.events, this.host.hermes.shown ?? ""), Date.now(), true);
    this.checkBudget();
    this.renderPanelBits();
  }

  /** Who scratches their head: the character that last ran the tool in question, else the last one active. */
  private roleFor(view: SessionView | null, tool?: string): Role | null {
    if (!view) return null;
    if (tool) {
      const open = Object.values(view.openTools).filter((t) => t.name === tool).at(-1);
      if (open) return open.role;
      for (let i = view.log.length - 1; i >= 0; i--) { const l = view.log[i]; if (l.agent !== "system" && new RegExp(`(^|[→✓✗] )${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l.text)) return l.agent; }
    }
    for (let i = view.log.length - 1; i >= 0; i--) { const a = view.log[i].agent; if (a !== "system") return a; }
    return view.lastRole ?? "pm";
  }

  private checkStuck(session: string | null, events: ExtEvent[], now: number, live: boolean) {
    const prev = this.stuckNow;
    let reasons = session && events.length ? detectStuck(events, now, live ? this.stuck : { ...this.stuck, idleMin: 0 }) : [];
    reasons = reasons.filter((r) => !this.dismissed.has(stuckKey(session!, r)));
    const view = live ? this.host.hermes.session : this.rp ? this.rp.st.sessions[this.rp.session] ?? null : null;
    const role = reasons.length ? this.roleFor(view, reasons.find((r) => r.tool)?.tool) : null;
    if (prev?.role && prev.role !== role) this.host.office.setStuck(prev.role, false);
    if (role) this.host.office.setStuck(role, true);
    this.stuckNow = reasons.length ? { session: session!, reasons, role } : null;
    if (live && reasons.length) {
      const fresh = reasons.filter((r) => this.gate.first(stuckKey(session!, r)));
      if (fresh.length) emitSignal({ type: "session.stuck", session: session!, title: view?.title ?? session!, reasons: fresh, office: this.host.officeAccess()?.id, at: now });
    }
  }

  // ---------- costs data ----------
  private costEvents(): { events: ExtEvent[]; sample: boolean; truncated: boolean } {
    const h = this.host.hermes;
    const local = h.events;
    if (h.mode === "demo") return { events: [...sampleHistory(Date.now()), ...local], sample: true, truncated: false };
    const acc = this.host.officeAccess();
    if (this.remote && acc && this.remote.key === acc.id) {
      const maxSeq = this.remote.events.reduce((m, e) => Math.max(m, e.seq), 0);
      return { events: [...this.remote.events, ...attribute(local).filter((e) => e.seq > maxSeq)], sample: false, truncated: this.remote.truncated };
    }
    return { events: local, sample: false, truncated: false };
  }

  /** Loads the whole office's model calls from the Worker (beyond what this tab replayed). */
  private async loadRemote(force = false) {
    const acc = this.host.officeAccess();
    if (!acc || this.host.hermes.mode === "demo" || this.remoteBusy) return;
    if (!force && this.remote && this.remote.key === acc.id && Date.now() - this.remote.at < 5 * 60_000) return;
    this.remoteBusy = true;
    try {
      const r = await fetch(`/api/ext/runs/${encodeURIComponent(acc.id)}/insights`, { headers: { authorization: `Bearer ${acc.token}` } });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { events: ExtEvent[]; truncated: boolean };
      this.remote = { key: acc.id, events: j.events ?? [], truncated: !!j.truncated, at: Date.now() };
    } catch {
      this.remote = this.remote ?? null; // keep what we had; the dashboard falls back to loaded events
    } finally {
      this.remoteBusy = false;
      this.checkBudget();
      this.renderPanelBits();
      if (!this.els.overlay.hidden && this.tab === "costs") this.renderOverlay();
    }
  }

  private checkBudget() {
    if (!this.onHermes || (this.budget.dailyUsd === null && this.budget.monthlyUsd === null)) { this.budgetNow = null; return; }
    if (!this.remote) void this.loadRemote();
    const { events } = this.costEvents();
    const sp = spendNow(events);
    const st = budgetStatus(sp, this.budget);
    this.budgetNow = st;
    if (st.level === "over" && st.period) {
      const sig = { type: "budget.exceeded" as const, period: st.period, periodKey: st.period === "day" ? sp.dayKey : sp.monthKey, spentUsd: Number(st.spentUsd.toFixed(6)), limitUsd: st.limitUsd, office: this.host.officeAccess()?.id, at: Date.now() };
      if (this.gate.first(budgetKey(sig))) emitSignal(sig);
    }
  }

  // ---------- panel bits: banners, summary card, replay button ----------
  renderPanelBits() {
    if (!this.els) return;
    const hx = this.onHermes;
    const h = this.host.hermes;
    // banners
    let html = "";
    const b = this.budgetNow;
    if (hx && b && b.level !== "ok" && b.period) {
      const key = `${b.level}:${b.period}:${b.limitUsd}`;
      if (!this.dismissed.has(`budget:${key}`)) {
        html += `<div class="ins-banner ${b.level === "over" ? "is-bad" : "is-warn"}" role="alert" data-banner="budget"><b>${b.level === "over" ? `${b.period === "day" ? "Daily" : "Monthly"} budget exceeded` : `${Math.round(b.share * 100)}% of the ${b.period === "day" ? "daily" : "monthly"} budget`}</b><span>${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)} ${b.period === "day" ? "today" : "this month"}. Overtime only warns; Hermes keeps running.</span><span class="ins-banner-act"><button type="button" class="link-btn" data-ins="costs">Costs</button><button type="button" class="link-btn" data-ins="dismiss-budget" data-key="${esc(key)}">Dismiss</button></span></div>`;
      }
    }
    const s = this.stuckNow;
    if (hx && s && s.reasons.length) {
      html += `<div class="ins-banner is-bad" role="alert" data-banner="stuck"><b>${this.rp ? "Replay: Hermes looked stuck here" : "Hermes looks stuck"}</b><ul>${s.reasons.map((r) => `<li>${esc(r.text)}</li>`).join("")}</ul><span class="ins-banner-act"><button type="button" class="link-btn" data-ins="timeline">Timeline</button><button type="button" class="link-btn" data-ins="alerts">Thresholds</button>${this.rp ? "" : `<button type="button" class="link-btn" data-ins="dismiss-stuck">Dismiss</button>`}</span></div>`;
    }
    if (this.els.banners.innerHTML !== html) {
      this.els.banners.innerHTML = html;
      this.els.banners.querySelectorAll<HTMLElement>("[data-ins]").forEach((el) => el.addEventListener("click", () => this.bannerAction(el)));
    }
    // end-of-session card
    const sid = h.shown;
    const all = hx && sid ? sessionEvents(h.events, sid) : [];
    const evs = this.rp ? [] : all;
    const ended = evs.length > 2 && !turnState(evs).open && evs.some((e) => e.type === "llm.call" || e.type === "tool.end");
    const card = this.els.card;
    if (ended && sid) {
      const st = sessionStats(h.events, sid);
      const c = `<div class="ins-card-head"><b>Session summary</b><span>${esc(headline(st))}</span></div><p>${esc(clipText(whatWasDone(st)[0] ?? "", 84))}</p><div class="task-row"><button type="button" class="btn btn-sm" data-ins="summary">Summary card</button><button type="button" class="btn btn-sm" data-ins="replay">▶ Replay</button><button type="button" class="link-btn" data-ins="timeline">Timeline</button></div>`;
      if (card.dataset.sig !== `${sid}:${st.events}`) {
        card.innerHTML = c;
        card.dataset.sig = `${sid}:${st.events}`;
        card.querySelectorAll<HTMLElement>("[data-ins]").forEach((el) => el.addEventListener("click", () => this.bannerAction(el)));
      }
      card.hidden = false;
    } else card.hidden = true;
    this.els.open.hidden = !hx || !!this.rp || all.length < 2;
  }

  private bannerAction(el: HTMLElement) {
    const a = el.dataset.ins!;
    if (a === "dismiss-budget") { this.dismissed.add(`budget:${el.dataset.key}`); this.renderPanelBits(); return; }
    if (a === "dismiss-stuck") {
      const s = this.stuckNow;
      if (s) { for (const r of s.reasons) this.dismissed.add(stuckKey(s.session, r)); if (s.role) this.host.office.setStuck(s.role, false); }
      this.stuckNow = null;
      this.renderPanelBits();
      return;
    }
    if (a === "replay") { const s = this.host.hermes.shown; if (s) this.enterReplay(s, { play: true }); return; }
    if (a === "summary") { this.sumSession = this.host.hermes.shown; this.open("summary"); return; }
    this.open(a as Tab);
  }

  // ---------- overlay ----------
  open(tab?: Tab) {
    if (tab) this.tab = tab;
    this.host.openOverlay();
  }

  /** Positions the sheet (below the office on phones, so a timeline jump stays visible) and renders it. */
  renderOverlay() {
    const el = this.els.overlay;
    if (window.innerWidth <= 760) {
      if (el.hidden) window.scrollTo(0, 0);
      const r = this.host.officeEl.getBoundingClientRect();
      el.style.top = `${Math.max(120, Math.round(r.bottom))}px`;
    } else el.style.top = "";
    const tabs: [Tab, string][] = [["timeline", "Timeline"], ["summary", "Summary"], ["costs", "Costs"], ["alerts", "Alerts"]];
    const head = `<div class="ov-head"><h2>Insights</h2><div class="tabs" role="tablist">${tabs.map(([t, l]) => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${this.tab === t}">${l}</button>`).join("")}</div><span class="spacer"></span><button class="btn btn-sm" data-close>Close</button></div>`;
    let body = "";
    if (!this.onHermes) body = `<div class="ins-body"><p class="ins-empty">Insights cover Hermes sessions. Switch to <b>Hermes · watch my agent</b> or the recorded Hermes demo.</p></div>`;
    else if (this.tab === "timeline") body = this.timelineHTML();
    else if (this.tab === "summary") body = this.summaryHTML();
    else if (this.tab === "costs") body = this.costsHTML();
    else body = this.alertsHTML();
    const keep = el.querySelector<HTMLElement>(".ins-body")?.scrollTop ?? 0;
    const sameTab = el.dataset.tab === this.tab;
    el.innerHTML = head + body;
    el.dataset.tab = this.tab;
    if (sameTab) { const b = el.querySelector<HTMLElement>(".ins-body"); if (b) b.scrollTop = keep; }
    el.querySelector("[data-close]")!.addEventListener("click", () => this.host.closeOverlay());
    el.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => { this.tab = b.dataset.tab as Tab; this.renderOverlay(); }));
    if (this.onHermes) {
      if (this.tab === "timeline") this.bindTimeline(el);
      else if (this.tab === "summary") this.bindSummary(el);
      else if (this.tab === "costs") this.bindCosts(el);
      else this.bindAlerts(el);
    }
  }

  private sessionsList(): { id: string; title: string }[] {
    const h = this.host.hermes;
    const titles = sessionTitles(h.events);
    return sessionIds(h.events).map((id) => ({ id, title: h.st.sessions[id]?.title ?? titles[id] ?? id }));
  }

  private sessionPicker(cur: string | null, attr: string): string {
    const list = this.sessionsList();
    if (list.length <= 1) return "";
    return `<label class="field ins-pick"><span class="sr-only">Session</span><select ${attr}>${list.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? "selected" : ""}>${esc(s.title.length > 48 ? s.title.slice(0, 47) + "…" : s.title)}</option>`).join("")}</select></label>`;
  }

  // ---------- timeline ----------
  private currentTimelineSession(): string | null {
    const h = this.host.hermes;
    if (this.rp) return this.rp.session;
    if (this.tlSession && sessionIds(h.events).includes(this.tlSession)) return this.tlSession;
    return h.shown;
  }

  private timelineHTML(): string {
    const sid = this.currentTimelineSession();
    const evs = sid ? (this.rp && this.rp.session === sid ? this.rp.events : sessionEvents(this.host.hermes.events, sid)) : [];
    if (!evs.length) return `<div class="ins-body"><p class="ins-empty">No events yet. The timeline fills in as Hermes works${this.host.hermes.mode === "demo" ? " (press <b>Play demo</b>)" : ""}.</p></div>`;
    const items = toTimeline(evs);
    const counts = countByFilter(items);
    const shown = filterTimeline(items, this.filters, this.query);
    const t0 = evs[0].ts;
    const cursor = this.rp && this.rp.session === sid ? this.rp.clock.count - 1 : -1;
    const rows = shown.slice(0, this.tlLimit).map((it) => this.itemHTML(it, t0, cursor)).join("");
    return `<div class="ins-body ins-tl">
      <div class="ins-tools">${this.sessionPicker(sid, 'data-tl="session"')}
        <div class="chips" role="group" aria-label="Filter events">${FILTERS.map((f) => `<button type="button" class="chip" data-filter="${f}" aria-pressed="${this.filters.has(f)}">${FILTER_LABEL[f]} <small>${counts[f]}</small></button>`).join("")}</div>
        <label class="ins-search"><span class="sr-only">Search events</span><input type="search" data-tl="q" placeholder="Search events…" value="${esc(this.query)}" autocomplete="off"></label>
        <p class="cost-meta">${shown.length} of ${items.length} events · click one to jump the replay there${this.rp ? "" : " (opens the replay)"}. Details are redacted.</p></div>
      <ol class="tl" aria-label="Timeline">${rows || `<li class="tl-none">Nothing matches.</li>`}</ol>
      ${shown.length > this.tlLimit ? `<button type="button" class="btn btn-sm" data-tl="more">Show ${Math.min(300, shown.length - this.tlLimit)} more</button>` : ""}</div>`;
  }

  private itemHTML(it: TimelineItem, t0: number, cursor: number): string {
    const sel = this.selected === it.i;
    const cat = it.cats[0] ?? "session";
    const who = it.agent !== "main" ? `<span class="tl-agent">${esc(this.rp?.st.sessions[this.rp.session]?.subagents[it.agent]?.name ?? "subagent")}</span>` : "";
    const det = sel ? `<dl class="tl-detail">${it.detail.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") || "<dt>data</dt><dd>(none)</dd>"}<dt>type</dt><dd>${esc(it.type)}</dd><dt>time</dt><dd>${esc(new Date(it.ts).toLocaleTimeString("en-US", { hour12: false }))}</dd></dl>` : "";
    return `<li class="tl-item lv-${it.level}${sel ? " is-sel" : ""}${it.i === cursor ? " is-now" : ""}" data-cat="${cat}"><button type="button" class="tl-row" data-i="${it.i}" aria-expanded="${sel}"><time>+${fmtClock(it.ts - t0)}</time><span class="tl-ico" aria-hidden="true">${ICON[cat] ?? "·"}</span><span class="tl-title">${esc(it.title)}${who}</span></button>${det}</li>`;
  }

  private bindTimeline(el: HTMLElement) {
    el.querySelectorAll<HTMLElement>("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.filter as Filter;
      if (this.filters.has(f)) this.filters.delete(f); else this.filters.add(f);
      this.renderOverlay();
    }));
    const q = el.querySelector<HTMLInputElement>('[data-tl="q"]');
    q?.addEventListener("input", () => {
      this.query = q.value;
      const pos = q.selectionStart;
      this.renderOverlay();
      const n = this.els.overlay.querySelector<HTMLInputElement>('[data-tl="q"]');
      if (n) { n.focus(); n.setSelectionRange(pos, pos); }
    });
    el.querySelector<HTMLSelectElement>('[data-tl="session"]')?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.tlSession = v;
      this.selected = null;
      if (this.rp && this.rp.session !== v) this.exitReplay(true);
      this.renderOverlay();
    });
    el.querySelector('[data-tl="more"]')?.addEventListener("click", () => { this.tlLimit += 300; this.renderOverlay(); });
    el.querySelectorAll<HTMLElement>(".tl-row").forEach((b) => b.addEventListener("click", () => this.jumpTo(Number(b.dataset.i))));
  }

  /** Timeline click: open the replay on that session (paused) at that event, and show its details. */
  jumpTo(i: number) {
    const sid = this.currentTimelineSession();
    if (!sid) return;
    if (!this.rp || this.rp.session !== sid) this.enterReplay(sid, { play: false });
    const r = this.rp;
    if (!r) return;
    r.clock.pause();
    this.rebuild(r.clock.seekToEvent(i));
    this.selected = this.selected === i ? null : i;
    if (this.selected === null) this.selected = i;
    this.renderBar();
    this.renderOverlay();
    this.els.overlay.querySelector<HTMLElement>(".tl-item.is-sel")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- replay ----------
  enterReplay(session: string, opts: { play: boolean }) {
    const h = this.host.hermes;
    const events = sessionEvents(h.events, session);
    if (events.length < 1) { this.host.toast("Nothing to replay yet."); return; }
    this.exitReplay(false);
    h.suspended = true;
    const schedule = buildSchedule(events);
    const clock = new ReplayClock(schedule);
    clock.speed = this.speed;
    const st = newOffice(h.rules);
    const rp: Replay = {
      session, title: h.st.sessions[session]?.title ?? sessionTitles(h.events)[session] ?? "Hermes session", events, schedule, clock, st,
      driver: new SceneDriver(this.host.office, () => this.rp?.st.sessions[session] ?? null, () => this.rp?.clock.speed ?? 1),
      raf: 0, last: performance.now(), lastPanel: 0, speedBefore: this.host.office.speed, exporting: null, wasPlaying: false,
    };
    this.rp = rp;
    this.host.office.speed = 1 / clock.speed;
    for (const r of ROLES) this.host.office.setStuck(r, false);
    this.stuckNow = null;
    $("#approval").hidden = true;
    this.host.officeEl.classList.add("is-replay");
    this.els.bar.hidden = false;
    this.rebuild(0);
    if (opts.play) clock.play();
    const loop = (t: number) => {
      if (this.rp !== rp) return;
      rp.raf = requestAnimationFrame(loop);
      const dt = Math.min(rp.exporting ? 100 : 250, t - rp.last);
      rp.last = t;
      const { from, to } = rp.clock.tick(dt);
      for (let k = from; k < to; k++) this.applyLive(rp.events[k]);
      if (to > from) {
        if (this.selected !== null && to - 1 > this.selected) this.selected = null;
        this.checkStuck(rp.session, rp.events.slice(0, to), rp.events[to - 1].ts, false);
        this.renderPanelBits();
      }
      if (to > from || t - rp.lastPanel > 250) { this.renderReplayPanel(); rp.lastPanel = t; }
      this.updateBarClock();
      if (rp.exporting) rp.exporting.rec.frame(this.caption(), dt);
      if (rp.exporting && rp.clock.ended) void this.finishExport();
      else if (rp.wasPlaying && !rp.clock.playing) this.renderBar();
      rp.wasPlaying = rp.clock.playing;
    };
    rp.raf = requestAnimationFrame(loop);
    this.renderBar();
    this.renderPanelBits();
    if (!this.els.overlay.hidden) this.renderOverlay();
  }

  private applyLive(e: ExtEvent) {
    const r = this.rp!;
    const { session, effects } = applyEvent(r.st, e);
    if (session === r.session) for (const f of effects) r.driver.effect(f);
  }

  /** Rebuilds the replay state up to n events without animation, then redraws the office. */
  private rebuild(n: number) {
    const r = this.rp!;
    r.st = newOffice(this.host.hermes.rules);
    for (let k = 0; k < n; k++) applyEvent(r.st, r.events[k]);
    r.driver.sync(r.st.sessions[r.session] ?? null);
    this.checkStuck(r.session, r.events.slice(0, n), n ? r.events[n - 1].ts : 0, false);
    this.renderReplayPanel();
    this.renderPanelBits();
  }

  exitReplay(resync = true) {
    const r = this.rp;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    if (r.exporting) { r.exporting.rec.cancel(); r.exporting = null; }
    r.driver.cancel();
    this.rp = null;
    this.host.office.speed = r.speedBefore;
    for (const role of ROLES) this.host.office.setStuck(role, false);
    this.stuckNow = null;
    this.selected = null;
    this.host.officeEl.classList.remove("is-replay");
    this.els.bar.hidden = true;
    this.els.bar.innerHTML = "";
    const h = this.host.hermes;
    h.suspended = false;
    if (resync) { h.syncScene(); this.check(); }
    this.renderPanelBits();
    if (!this.els.overlay.hidden) this.renderOverlay();
  }

  private renderReplayPanel() {
    const r = this.rp;
    if (!r) return;
    const s = r.st.sessions[r.session];
    if (!s) {
      this.host.renderLog([], Date.now(), "Replay: nothing has happened yet at this point.");
      return;
    }
    this.host.renderSteps(s.steps);
    this.host.renderLog(s.log, s.startedAt);
    const names = Object.fromEntries(ROLES.filter((x) => s.agents[x].name !== ROLE_INFO[x].name).map((x) => [x, s.agents[x].name]));
    this.host.renderCost(s.cost.usd, s.cost.tokens, s.cost.byAgent, { meta: `${fmtTokens(s.cost.tokens)} tokens · ${s.cost.calls} model call${s.cost.calls === 1 ? "" : "s"} · replay`, names, note: "Replay: cost so far at this point of the session." });
    this.host.setChip(`<b>Replay</b> · ${r.clock.speed}x · ${fmtClock(r.clock.t)} / ${fmtClock(r.schedule.total)}`, r.clock.playing ? "running" : "idle");
  }

  private caption() {
    const r = this.rp!;
    const s = r.st.sessions[r.session];
    const model = s?.model ?? "";
    return { title: r.title, meta: `${fmtUsd(s?.cost.usd ?? 0)} · ${fmtTokens(s?.cost.tokens ?? 0)} tokens${model ? ` · ${model}` : ""}`, clock: fmtClock(r.clock.t) };
  }

  private setSpeed(v: number) {
    const r = this.rp;
    this.speed = v;
    this.save();
    if (r) { r.clock.speed = v; this.host.office.speed = 1 / v; }
  }

  private renderBar() {
    const r = this.rp;
    const bar = this.els.bar;
    if (!r) return;
    const exp = r.exporting;
    const errs = r.events.map((e, i) => ((e.type === "tool.end" && !(e.data as EventData["tool.end"]).ok) || e.type === "error" ? i : -1)).filter((i) => i >= 0);
    const marks = errs.slice(0, 60).map((i) => `<i style="left:${((r.schedule.at[i] / Math.max(1, r.schedule.total)) * 100).toFixed(2)}%"></i>`).join("");
    const mp4 = pickMime("mp4"), webm = pickMime("webm");
    const kinds: [ExportKind, string, boolean][] = [["gif", "GIF", true], ["webm", "WebM", !!webm], ["mp4", "MP4", !!mp4]];
    const res = this.exportResult;
    bar.innerHTML = `<div class="rp-row">
        <button type="button" class="rp-btn" data-rp="play" aria-label="${r.clock.playing ? "Pause" : "Play"}" ${exp ? "disabled" : ""}>${r.clock.playing ? "❚❚" : "▶"}</button>
        <button type="button" class="rp-btn" data-rp="prev" aria-label="Previous event" title="Previous event" ${exp ? "disabled" : ""}>${ICON_PREV}</button>
        <button type="button" class="rp-btn" data-rp="next" aria-label="Next event" title="Next event" ${exp ? "disabled" : ""}>${ICON_NEXT}</button>
        <div class="rp-track"><input type="range" data-rp="scrub" min="0" max="${Math.round(r.schedule.total)}" step="10" value="${Math.round(r.clock.t)}" aria-label="Replay position" ${exp ? "disabled" : ""}><span class="rp-marks" aria-hidden="true">${marks}</span></div>
        <span class="rp-time" data-rp="time">${fmtClock(r.clock.t)} / ${fmtClock(r.schedule.total)}</span>
        <label class="sr-only" for="rp-speed">Replay speed</label>
        <select id="rp-speed" class="rp-speed" data-rp="speed" ${exp ? "disabled" : ""}>${SPEEDS.map((s) => `<option value="${s}" ${s === r.clock.speed || (exp && s === exp.chosen) ? "selected" : ""}>${s}x</option>`).join("")}</select>
        <button type="button" class="rp-btn rp-txt" data-rp="export-toggle" aria-expanded="${!!bar.dataset.export}">Export</button>
        <button type="button" class="rp-btn rp-txt" data-rp="timeline">Timeline</button>
        <button type="button" class="rp-btn rp-txt rp-live" data-rp="close" aria-label="Exit replay">Live ✕</button>
      </div>
      ${bar.dataset.export ? `<div class="rp-export" role="group" aria-label="Export the replay">
        <div class="rp-kinds">${kinds.map(([k, l, ok]) => `<label class="check"><input type="radio" name="rp-kind" value="${k}" ${this.exportOpts.kind === k ? "checked" : ""} ${ok && !exp ? "" : "disabled"}> ${l}${ok ? "" : " <small>(not in this browser)</small>"}</label>`).join("")}</div>
        <label class="check"><input type="checkbox" data-rp="caption" ${this.exportOpts.caption ? "checked" : ""} ${exp ? "disabled" : ""}> Caption (task and cost)</label>
        <label class="check"><input type="checkbox" data-rp="corner" ${this.exportOpts.corner ? "checked" : ""} ${exp ? "disabled" : ""}> “made with Overtime” corner</label>
        <div class="task-row">${exp ? `<button type="button" class="btn btn-sm" data-rp="export-cancel">Cancel</button>` : `<button type="button" class="btn btn-sm btn-primary" data-rp="export-start">Record ${this.exportOpts.kind.toUpperCase()}</button>`}<span class="cost-meta" data-rp="export-status">${esc(this.exportStatus || this.exportHint())}</span></div>
        ${res ? `<div class="rp-result" data-rp="result">${res.gifPreview ? `<img src="${res.url}" alt="Exported GIF preview">` : ""}<a class="btn btn-sm" href="${res.url}" download="${esc(res.name)}" title="${esc(res.name)}">Download ${res.kind === "gif" ? "GIF" : res.name.endsWith(".mp4") ? "MP4" : "WebM"}</a><span class="cost-meta">${fmtBytes(res.size)}</span></div>` : ""}
      </div>` : ""}`;
    this.bindBar();
  }

  private exportHint(): string {
    const r = this.rp;
    if (!r) return "";
    const gif = this.exportOpts.kind === "gif";
    const sp = exportSpeed(r.schedule, r.clock.speed, gif ? 20 : 40);
    return `≈ ${Math.max(1, Math.round(realLength(r.schedule, sp) / 1000))} s at ${sp}x${sp > r.clock.speed ? " (sped up to keep the file small)" : ""}, ${gif ? "560 px, 10 fps" : "960 px, 30 fps"}`;
  }

  private updateBarClock() {
    const r = this.rp;
    if (!r) return;
    const scrub = this.els.bar.querySelector<HTMLInputElement>('[data-rp="scrub"]');
    if (scrub && document.activeElement !== scrub) scrub.value = String(Math.round(r.clock.t));
    const t = this.els.bar.querySelector<HTMLElement>('[data-rp="time"]');
    if (t) t.textContent = `${fmtClock(r.clock.t)} / ${fmtClock(r.schedule.total)}`;
    const play = this.els.bar.querySelector<HTMLElement>('[data-rp="play"]');
    if (play) { const want = r.clock.playing ? "❚❚" : "▶"; if (play.textContent !== want) { play.textContent = want; play.setAttribute("aria-label", r.clock.playing ? "Pause" : "Play"); } }
  }

  private bindBar() {
    const bar = this.els.bar;
    const q = <T extends HTMLElement>(k: string) => bar.querySelector<T>(`[data-rp="${k}"]`);
    q("play")?.addEventListener("click", () => { const r = this.rp!; if (r.clock.playing) r.clock.pause(); else r.clock.play(); if (r.clock.t === 0) this.rebuild(0); this.renderBar(); this.renderReplayPanel(); });
    q("prev")?.addEventListener("click", () => { const r = this.rp!; r.clock.pause(); this.rebuild(r.clock.seekToEvent(r.clock.prevEvent())); this.afterJump(); });
    q("next")?.addEventListener("click", () => { const r = this.rp!; r.clock.pause(); this.rebuild(r.clock.seekToEvent(r.clock.nextEvent())); this.afterJump(); });
    const scrub = q<HTMLInputElement>("scrub");
    scrub?.addEventListener("input", () => { const r = this.rp!; this.rebuild(r.clock.seek(Number(scrub.value))); this.updateBarClock(); });
    scrub?.addEventListener("change", () => { if (!this.els.overlay.hidden) this.renderOverlay(); });
    q<HTMLSelectElement>("speed")?.addEventListener("change", (e) => { this.setSpeed(Number((e.target as HTMLSelectElement).value)); this.renderBar(); this.renderReplayPanel(); });
    q("export-toggle")?.addEventListener("click", () => { if (bar.dataset.export) delete bar.dataset.export; else bar.dataset.export = "1"; this.renderBar(); });
    q("timeline")?.addEventListener("click", () => this.open("timeline"));
    q("close")?.addEventListener("click", () => this.exitReplay(true));
    bar.querySelectorAll<HTMLInputElement>('input[name="rp-kind"]').forEach((i) => i.addEventListener("change", () => { this.exportOpts.kind = i.value as ExportKind; this.exportStatus = ""; this.renderBar(); }));
    q<HTMLInputElement>("caption")?.addEventListener("change", (e) => { this.exportOpts.caption = (e.target as HTMLInputElement).checked; });
    q<HTMLInputElement>("corner")?.addEventListener("change", (e) => { this.exportOpts.corner = (e.target as HTMLInputElement).checked; });
    q("export-start")?.addEventListener("click", () => this.startExport(this.exportOpts.kind));
    q("export-cancel")?.addEventListener("click", () => this.cancelExport());
  }

  private afterJump() {
    const r = this.rp!;
    this.selected = Math.max(0, r.clock.count - 1);
    this.renderBar();
    if (!this.els.overlay.hidden) this.renderOverlay();
  }

  // ---------- export ----------
  startExport(kind: ExportKind) {
    const r = this.rp;
    if (!r || r.exporting) return;
    const mime = kind === "gif" ? null : pickMime(kind);
    if (kind !== "gif" && !mime) { this.host.toast(`${kind.toUpperCase()} recording is not supported in this browser. Try GIF${pickMime("webm") ? " or WebM" : ""}.`); return; }
    const chosen = r.clock.speed;
    const sp = exportSpeed(r.schedule, chosen, kind === "gif" ? 20 : 40);
    let rec: Recorder;
    try {
      const comp = new FrameComposer(this.host.officeEl, kind === "gif" ? 560 : 960, { caption: this.exportOpts.caption, corner: this.exportOpts.corner });
      rec = kind === "gif" ? gifRecorder(comp, 10) : videoRecorder(comp, mime!, 30);
    } catch (e) {
      this.host.toast(`Could not start the recording: ${(e as Error).message}`);
      return;
    }
    if (this.exportResult) { URL.revokeObjectURL(this.exportResult.url); this.exportResult = null; }
    r.exporting = { kind, rec, chosen };
    this.exportStatus = `Recording at ${sp}x…`;
    r.clock.speed = sp;
    this.host.office.speed = 1 / sp;
    r.clock.pause();
    this.rebuild(r.clock.seek(0));
    r.clock.play();
    this.renderBar();
  }

  private cancelExport() {
    const r = this.rp;
    if (!r?.exporting) return;
    r.exporting.rec.cancel();
    r.clock.speed = r.exporting.chosen;
    this.host.office.speed = 1 / r.clock.speed;
    r.exporting = null;
    r.clock.pause();
    this.exportStatus = "Cancelled.";
    this.renderBar();
  }

  private async finishExport() {
    const r = this.rp;
    if (!r?.exporting) return;
    const ex = r.exporting;
    r.exporting = null;
    r.clock.speed = ex.chosen;
    this.host.office.speed = 1 / ex.chosen;
    this.exportStatus = "Encoding…";
    this.renderBar();
    try {
      const blob = await ex.rec.finish();
      const ext = ex.kind === "gif" ? "gif" : blob.type.includes("mp4") ? "mp4" : "webm";
      const name = `overtime-replay-${slug(r.title)}.${ext}`;
      this.exportResult = { url: URL.createObjectURL(blob), name, size: blob.size, kind: ex.kind, gifPreview: ex.kind === "gif" };
      this.exportStatus = `Done: ${fmtBytes(blob.size)}.`;
      // the single-file preview runs in a sandbox without downloads: the result stays inline
      if (blob.size > 0 && !__PREVIEW__) download(blob, name);
      else if (!blob.size) this.exportStatus = "The recording came out empty.";
    } catch (e) {
      this.exportStatus = `Export failed: ${(e as Error).message}`;
    }
    this.renderBar();
  }

  // ---------- summary ----------
  private currentSummarySession(): string | null {
    const ids = sessionIds(this.host.hermes.events);
    if (this.sumSession && ids.includes(this.sumSession)) return this.sumSession;
    return this.rp?.session ?? this.host.hermes.shown ?? ids[0] ?? null;
  }

  private canAI(): boolean {
    const s = this.host.settings();
    return s.mode === "live" && !!secrets.apiKey(s) && !__PREVIEW__;
  }

  private summaryHTML(): string {
    const sid = this.currentSummarySession();
    if (!sid) return `<div class="ins-body"><p class="ins-empty">No session yet. The summary card appears when a session ends.</p></div>`;
    const s = sessionStats(this.host.hermes.events, sid);
    const ai = this.ai[sid];
    const set = this.host.settings();
    const tok = s.tokens;
    return `<div class="ins-body ins-sum">${this.sessionPicker(sid, 'data-sum="session"')}
      <article class="sum-card" aria-label="Session summary">
        <p class="sum-kicker">Hermes session · ${esc(new Date(s.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}<span class="sum-status st-${s.status}">${STATUS_LABEL[s.status]}</span></p>
        <h3>${esc(s.title)}</h3>
        <div class="sum-stats">${[["Duration", fmtDuration(s.durationMs)], ["Cost", fmtUsd(s.usd) + (s.unpriced.length ? "+" : "")], ["Tokens", fmtTokens(tok.total)], ["Model calls", String(s.calls)]].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
        <p class="sum-models">Models: ${s.models.length ? s.models.map((m) => `<code>${esc(m)}</code>`).join(" ") : "unknown"}${s.unpriced.length ? ` · no price known for ${s.unpriced.map(esc).join(", ")}` : ""}</p>
        ${ai ? `<blockquote class="sum-ai">${esc(ai)}<small>Written by ${esc(set.model)} from the facts below.</small></blockquote>` : ""}
        <h4>What was done</h4><ul class="sum-done">${whatWasDone(s).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <div class="sum-cols">
          <section><h4>Files changed · ${s.files.length}</h4>${s.files.length ? `<ul>${s.files.slice(0, 12).map((f) => `<li><code>${esc(f.path)}</code> <small>${esc(f.op)}${f.count > 1 ? ` ×${f.count}` : ""}</small></li>`).join("")}</ul>` : "<p>None</p>"}</section>
          <section><h4>Top tools</h4>${s.tools.length ? `<ul>${s.tools.slice(0, 8).map((t) => `<li><code>${esc(t.name)}</code> ×${t.count}${t.fails ? ` <small class="bad">${t.fails} failed</small>` : ""}</li>`).join("")}</ul>` : "<p>None</p>"}</section>
          <section><h4>Errors · ${s.errors.length}</h4>${s.errors.length ? `<ul>${s.errors.slice(0, 6).map((e) => `<li class="bad">${esc(e.text)}</li>`).join("")}</ul>` : "<p>None</p>"}</section>
        </div>
        <p class="cost-meta">${fmtTokens(tok.input)} in · ${fmtTokens(tok.output)} out · ${fmtTokens(tok.cacheRead)} cache read${tok.cacheWrite ? ` · ${fmtTokens(tok.cacheWrite)} cache write` : ""} · ${s.events} events</p>
      </article>
      <div class="task-row ins-actions"><button type="button" class="btn btn-sm btn-primary" data-sum="png">Download PNG</button><button type="button" class="btn btn-sm" data-sum="md-copy">Copy markdown</button><button type="button" class="btn btn-sm" data-sum="md">Download .md</button><button type="button" class="btn btn-sm" data-sum="replay">▶ Replay</button></div>
      <p class="cost-meta">${this.canAI() ? `<button type="button" class="link-btn" data-sum="ai" ${this.aiBusy ? "disabled" : ""}>${this.aiBusy ? "Writing…" : ai ? "Rewrite the summary" : `Write a summary with ${esc(set.model)}`}</button> · sends only the derived facts above (no prompts, files or outputs) with your key.` : "Optional: add your own model key under Settings → Live to get a two-line written summary. The card above needs no model."}</p>
    </div>`;
  }

  private bindSummary(el: HTMLElement) {
    const sid = this.currentSummarySession();
    el.querySelector<HTMLSelectElement>('[data-sum="session"]')?.addEventListener("change", (e) => { this.sumSession = (e.target as HTMLSelectElement).value; this.renderOverlay(); });
    if (!sid) return;
    const stats = () => sessionStats(this.host.hermes.events, sid);
    const when = () => new Date(stats().startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    el.querySelector('[data-sum="png"]')?.addEventListener("click", async () => {
      try {
        const blob = await canvasBlob(drawSummaryCard(stats(), { aiSummary: this.ai[sid], when: when() }));
        download(blob, `overtime-session-${slug(stats().title)}.png`);
        this.host.toast(`Summary card saved as PNG (${fmtBytes(blob.size)}).`);
      } catch (e) { this.host.toast(`Could not make the PNG: ${(e as Error).message}`); }
    });
    const md = () => summaryMarkdown(stats(), { aiSummary: this.ai[sid], when: when() });
    el.querySelector('[data-sum="md-copy"]')?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(md()); this.host.toast("Markdown copied."); }
      catch { download(new Blob([md()], { type: "text/markdown" }), `overtime-session-${slug(stats().title)}.md`); this.host.toast("Clipboard blocked here, so the markdown was downloaded."); }
    });
    el.querySelector('[data-sum="md"]')?.addEventListener("click", () => download(new Blob([md()], { type: "text/markdown" }), `overtime-session-${slug(stats().title)}.md`));
    el.querySelector('[data-sum="replay"]')?.addEventListener("click", () => this.enterReplay(sid, { play: true }));
    el.querySelector('[data-sum="ai"]')?.addEventListener("click", () => void this.writeAI(sid));
  }

  private async writeAI(sid: string) {
    if (this.aiBusy || !this.canAI()) return;
    this.aiBusy = true;
    this.renderOverlay();
    try {
      const p = llmSummaryPrompt(sessionStats(this.host.hermes.events, sid));
      const llm = new OpenAICompatibleLLM(llmSettings(this.host.settings(), { output: "prompt", stream: false, maxTokens: 220 }));
      const r = await llm.complete({ agent: "pm", messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }] });
      this.ai[sid] = r.text.trim().replace(/^["']|["']$/g, "").slice(0, 600);
    } catch (e) {
      this.host.toast(`The model summary failed: ${(e as Error).message.slice(0, 140)}`);
    } finally {
      this.aiBusy = false;
      if (!this.els.overlay.hidden) this.renderOverlay();
    }
  }

  // ---------- costs ----------
  private costsHTML(): string {
    void this.loadRemote();
    const { events, sample, truncated } = this.costEvents();
    const days = costByDay(events, { days: this.costDays });
    const models = costByModel(events);
    const titles = sessionTitles(events);
    const sessions = costBySession(events, titles).slice(0, 8);
    const sp = spendNow(events);
    const tok = emptyTokens();
    let calls = 0, total = 0;
    for (const e of attribute(events)) if (e.type === "llm.call") { const c = llmCost(e.data as EventData["llm.call"]); calls++; total += c.usd ?? 0; for (const k of Object.keys(tok) as (keyof typeof tok)[]) tok[k] += c.tokens[k]; }
    const usd = this.costMode === "usd";
    const fmtV = usd ? fmtUsd : fmtTokens;
    const b = budgetStatus(sp, this.budget);
    const chart = barChart(days.map((d) => ({ label: d.label, value: usd ? d.usd : d.tokens, title: `${d.label}: ${fmtUsd(d.usd)} · ${fmtTokens(d.tokens)} tokens · ${d.calls} calls` })), { fmt: (v) => (usd ? (v >= 1 ? `$${v.toFixed(v >= 10 ? 0 : 1)}` : `$${v.toFixed(v >= 0.1 ? 2 : 3)}`) : fmtTokens(Math.round(v))), limit: usd ? this.budget.dailyUsd : null, label: `Cost per day, last ${this.costDays} days` });
    const unpriced = models.filter((m) => m.unpriced > 0).map((m) => m.key);
    return `<div class="ins-body ins-costs">
      ${sample ? `<p class="ins-note">Demo: the recorded session (today) plus ${this.costDays - 1} days of <b>sample</b> history, so the charts have something to show. A real office shows only Hermes' own numbers.</p>` : ""}
      ${b.level !== "ok" && b.period ? `<div class="ins-banner ${b.level === "over" ? "is-bad" : "is-warn"}" role="alert"><b>${b.level === "over" ? "Over budget" : "Close to the budget"}</b><span>${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)} ${b.period === "day" ? "today" : "this month"}.</span></div>` : ""}
      <div class="kpis">${[["Today", fmtUsd(sp.day), this.budget.dailyUsd ? `of ${fmtUsd(this.budget.dailyUsd)}` : "no daily limit"], ["This month", fmtUsd(sp.month), this.budget.monthlyUsd ? `of ${fmtUsd(this.budget.monthlyUsd)}` : "no monthly limit"], ["All loaded", fmtUsd(total), `${calls} model calls`], ["Tokens", fmtTokens(tok.total), `${fmtTokens(tok.output)} out`]].map(([k, v, s]) => `<div class="kpi"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join("")}</div>
      <section class="ch-card"><div class="ch-head"><h4>Per day</h4><span class="spacer"></span><div class="seg" role="group" aria-label="Metric"><button type="button" data-cost="usd" aria-pressed="${usd}">$</button><button type="button" data-cost="tokens" aria-pressed="${!usd}">Tokens</button></div><div class="seg" role="group" aria-label="Range"><button type="button" data-days="14" aria-pressed="${this.costDays === 14}">14d</button><button type="button" data-days="30" aria-pressed="${this.costDays === 30}">30d</button></div></div>${chart}</section>
      <section class="ch-card"><h4>Per model</h4>${models.length ? hBars(models.slice(0, 8).map((m) => ({ label: m.label, value: usd ? m.usd : m.tokens })), fmtV, { sub: (i) => `${models[i].calls} calls${models[i].unpriced ? " · unpriced" : ""}` }) : `<p class="ins-empty">No model calls yet.</p>`}</section>
      <section class="ch-card"><h4>Per session (top ${sessions.length})</h4>${sessions.length ? hBars(sessions.map((s) => ({ label: s.label, value: usd ? s.usd : s.tokens })), fmtV, { sub: (i) => `${sessions[i].calls} calls`, attr: (i) => `data-session="${esc(sessions[i].key)}" tabindex="0" role="button"` }) : `<p class="ins-empty">No sessions yet.</p>`}</section>
      <section class="ch-card"><h4>Tokens</h4>${stackBar([{ label: "Input", value: tok.input, cls: "k-in" }, { label: "Output", value: tok.output, cls: "k-out" }, { label: "Cache read", value: tok.cacheRead, cls: "k-cr" }, { label: "Cache write", value: tok.cacheWrite, cls: "k-cw" }], fmtTokens)}</section>
      <p class="cost-meta">Costs are Hermes' own estimates per model call (or list prices for known models).${unpriced.length ? ` No price known for ${unpriced.map(esc).join(", ")}: tokens only.` : ""}${truncated ? " Showing the newest 20,000 model calls." : ""}${!sample && !this.remote && this.host.officeAccess() ? " Loading the whole office…" : ""} Days are in your local time.</p>
      <p><button type="button" class="link-btn" data-ins-tab="alerts">Set a daily or monthly budget →</button></p>
    </div>`;
  }

  private bindCosts(el: HTMLElement) {
    el.querySelectorAll<HTMLElement>("[data-cost]").forEach((b) => b.addEventListener("click", () => { this.costMode = b.dataset.cost as "usd" | "tokens"; this.renderOverlay(); }));
    el.querySelectorAll<HTMLElement>("[data-days]").forEach((b) => b.addEventListener("click", () => { this.costDays = Number(b.dataset.days); this.renderOverlay(); }));
    el.querySelectorAll<HTMLElement>("[data-session]").forEach((b) => {
      const go = () => { const id = b.dataset.session!; if (sessionIds(this.host.hermes.events).includes(id)) { this.sumSession = id; this.tab = "summary"; this.renderOverlay(); } else this.host.toast("That session is not loaded in this tab (only its cost is)."); };
      b.addEventListener("click", go);
      b.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    });
    el.querySelector("[data-ins-tab]")?.addEventListener("click", () => { this.tab = "alerts"; this.renderOverlay(); });
  }

  // ---------- alerts (budget + stuck thresholds + signals) ----------
  private alertsHTML(): string {
    const b = this.budget, t = this.stuck;
    const num = (k: string, v: number | null, label: string, hint: string, step = "1", min = "0") => `<label class="field"><span>${label}</span><input type="number" inputmode="decimal" data-al="${k}" value="${v ?? ""}" step="${step}" min="${min}" placeholder="none"><small>${hint}</small></label>`;
    return `<div class="ins-body settings ins-alerts">
      <h3>Budget</h3>
      <p>A warning banner when Hermes' spend reaches ${Math.round(b.warnAt * 100)}% of a limit, and a red one past it. Overtime never stops Hermes.</p>
      <div class="ins-grid">${num("dailyUsd", b.dailyUsd, "Daily limit ($)", "Calendar day, local time", "0.01")}${num("monthlyUsd", b.monthlyUsd, "Monthly limit ($)", "Calendar month", "0.01")}</div>
      <h3>Stuck detection</h3>
      <label class="check"><input type="checkbox" data-al="enabled" ${t.enabled ? "checked" : ""}> Watch for a stuck session</label>
      <div class="ins-grid">
        ${num("repeatTool", t.repeatTool, "Same tool + same args", "times in a row", "1", "2")}
        ${num("repeatErrors", t.repeatErrors, "Failures", `among the last N results`, "1", "1")}
        ${num("errorWindow", t.errorWindow, "…of the last N results", "tool results and errors", "1", "1")}
        ${num("idleMin", t.idleMin, "Silence (minutes)", "while a turn runs; 0 = off", "1", "0")}
        ${num("costSpikeX", t.costSpikeX, "Cost spike (× median)", "one model call vs. the session", "0.5", "1.5")}
        ${num("costSpikeMinUsd", t.costSpikeMinUsd, "…and at least ($)", "ignore tiny spikes", "0.01", "0")}
      </div>
      <div class="task-row"><button type="button" class="btn btn-sm btn-primary" data-al="save">Save</button><button type="button" class="link-btn" data-al="reset">Reset to defaults</button><span class="cost-meta" data-al="msg"></span></div>
      <h3>Notifications hook</h3>
      <p>Insights emit two signals that a notifier (Telegram, web push) can subscribe to: <code>session.stuck</code> and <code>budget.exceeded</code>, each once per condition. In code: <code>onSignal(fn)</code> from <code>src/insights/signals.ts</code>; from outside: <code>window.addEventListener("overtime:signal", …)</code>. Schema in docs/EVENTS.md.</p>
      <ol class="sig-list" aria-label="Recent signals">${this.recentSignals.length ? this.recentSignals.map((s) => `<li><code>${s.type}</code> ${esc(s.type === "session.stuck" ? `${s.title}: ${s.reasons[0]?.text ?? ""}` : `${s.period} ${fmtUsd(s.spentUsd)} of ${fmtUsd(s.limitUsd)}`)} <small>${new Date(s.at).toLocaleTimeString("en-US", { hour12: false })}</small></li>`).join("") : `<li class="ins-empty">No signals in this tab yet.</li>`}</ol>
    </div>`;
  }

  private bindAlerts(el: HTMLElement) {
    const val = (k: string) => { const i = el.querySelector<HTMLInputElement>(`[data-al="${k}"]`)!; return i.value.trim() === "" ? null : Number(i.value); };
    el.querySelector('[data-al="save"]')!.addEventListener("click", () => {
      this.budget = normalizeBudget({ dailyUsd: val("dailyUsd"), monthlyUsd: val("monthlyUsd"), warnAt: this.budget.warnAt });
      this.stuck = normalizeThresholds({
        enabled: el.querySelector<HTMLInputElement>('[data-al="enabled"]')!.checked,
        repeatTool: val("repeatTool") ?? undefined, repeatErrors: val("repeatErrors") ?? undefined, errorWindow: val("errorWindow") ?? undefined,
        idleMin: val("idleMin") ?? undefined, costSpikeX: val("costSpikeX") ?? undefined, costSpikeMinUsd: val("costSpikeMinUsd") ?? undefined,
      });
      this.save();
      this.check();
      this.renderOverlay();
      const m = this.els.overlay.querySelector<HTMLElement>('[data-al="msg"]');
      if (m) m.textContent = "Saved.";
    });
    el.querySelector('[data-al="reset"]')!.addEventListener("click", () => { this.stuck = { ...DEFAULT_STUCK }; this.budget = { ...DEFAULT_BUDGET }; this.save(); this.check(); this.renderOverlay(); });
  }
}

/** test/debug helper: the stats of the session the office shows */
export function statsOf(h: HermesController): SessionStats | null {
  return h.shown ? sessionStats(h.events, h.shown) : null;
}
