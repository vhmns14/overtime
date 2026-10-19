// The run engine. A fixed pipeline (PM → Research → Coder ⇄ Reviewer → Ops) where each agent is
// an LLM loop that must answer with one validated JSON tool call per turn. Gates pause the run for
// the human; a budget cap, cancel and pause are checked before every model call.

import { runChecks, summarizeReport, type SyntaxChecker } from "./checks";
import { compactDiff, lineDiff } from "./diff";
import { costOf } from "./llm";
import { phaseMessage, systemPrompt, fence, type PhaseContext } from "./prompts";
import { parseToolCall, safePath } from "./schema";
import {
  ROLES, ROLE_INFO,
  type AgentState, type ChatMessage, type CheckReport, type DiffLine, type GateDecision, type GateRequest, type LLM,
  type LogEntry, type Role, type RunConfig, type RunEvent, type RunStatus, type Snapshot, type StepId, type StepState, type Ticket, type ToolCall,
} from "./types";

export class CancelledError extends Error { constructor() { super("Run cancelled"); this.name = "CancelledError"; } }
export class BudgetError extends Error { constructor(msg: string) { super(msg); this.name = "BudgetError"; } }
export class AgentError extends Error { constructor(msg: string) { super(msg); this.name = "AgentError"; } }

export interface Pace {
  /** awaited so the office can play the meeting before work continues */
  handoff?(from: Role, to: Role, summary: string): Promise<void>;
  tickets?(tickets: Ticket[]): Promise<void>;
}

export interface OrchestratorDeps {
  llm: LLM;
  config: RunConfig;
  runId: string;
  fetchRef?: (url: string, signal: AbortSignal) => Promise<string>;
  deploy?: (runId: string, files: Record<string, string>) => Promise<{ url: string; local: boolean }>;
  push?: (files: Record<string, string>) => Promise<{ url: string }>;
  pace?: Pace;
  syntax?: SyntaxChecker;
  now?: () => number;
}

const NEXT: Record<Role, Role | null> = { pm: "research", research: "coder", coder: "reviewer", reviewer: null, ops: null };
const ROLE_NAMES = new Set<string>(ROLES);

export const DEFAULT_CONFIG: Omit<RunConfig, "task"> = {
  gates: { plan: true, deploy: true, review: true },
  budgetUsd: 0.5,
  pricing: { input: 0.15, output: 0.6 },
  maxReviewRounds: 2,
  maxStepsPerAgent: 10,
  sizeBudgetBytes: 250_000,
};

export class Orchestrator {
  readonly files: Record<string, string> = {};
  tickets: Ticket[] = [];
  readonly snapshots: Snapshot[] = [];
  readonly log: LogEntry[] = [];
  readonly agents: Record<Role, AgentState>;
  readonly steps: Record<StepId, { state: StepState; pct?: number }> = {
    plan: { state: "pending" }, research: { state: "pending" }, code: { state: "pending" }, review: { state: "pending" }, deploy: { state: "pending" },
  };
  status: RunStatus = "idle";
  usage = { tokens: 0, usd: 0 };
  brief = "";
  lastReport: CheckReport | null = null;
  deployedUrl = "";
  summary = "";
  error = "";
  private listeners = new Set<(e: RunEvent) => void>();
  private abort = new AbortController();
  private paused: { promise: Promise<void>; resolve: () => void } | null = null;
  private pendingGate: { req: GateRequest; resolve: (d: GateDecision) => void; reject: (e: Error) => void } | null = null;
  private gateSeq = 0;
  private now: () => number;

  constructor(private deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.agents = Object.fromEntries(ROLES.map((r) => [r, { role: r, activity: "idle", thought: "", log: [], filesTouched: [], tokens: 0, cost: 0 }])) as unknown as Record<Role, AgentState>;
  }

  get config() { return this.deps.config; }
  get gate(): GateRequest | null { return this.pendingGate?.req ?? null; }

  on(fn: (e: RunEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: RunEvent) { for (const l of this.listeners) l(e); }

  private setStatus(s: RunStatus) { this.status = s; this.emit({ type: "status", status: s }); }
  private say(agent: Role | "system", text: string, level: LogEntry["level"] = "info") {
    const entry = { t: this.now(), agent, text, level };
    this.log.push(entry);
    if (agent !== "system") { const a = this.agents[agent]; a.log.push(text); if (a.log.length > 60) a.log.shift(); }
    this.emit({ type: "log", entry });
  }
  private setAgent(role: Role, patch: Partial<AgentState>) {
    Object.assign(this.agents[role], patch);
    this.emit({ type: "agent", role, state: { ...this.agents[role] } });
  }
  private setStep(id: StepId, state: StepState, pct?: number) {
    this.steps[id] = { state, pct };
    this.emit({ type: "step", id, state, pct });
  }
  private emitCost() {
    const byAgent = Object.fromEntries(ROLES.map((r) => [r, { tokens: this.agents[r].tokens, usd: this.agents[r].cost }])) as Record<Role, { tokens: number; usd: number }>;
    this.emit({ type: "cost", tokens: this.usage.tokens, usd: this.usage.usd, byAgent });
  }

  // ---------- control ----------
  cancel() {
    if (["done", "failed", "cancelled", "budget"].includes(this.status)) return;
    this.abort.abort();
    this.pendingGate?.reject(new CancelledError());
    this.paused?.resolve();
  }
  pause() {
    if (this.paused || this.status !== "running") return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.paused = { promise, resolve };
    this.setStatus("paused");
    this.say("system", "Run paused");
  }
  resume() {
    if (!this.paused) return;
    const p = this.paused;
    this.paused = null;
    this.setStatus("running");
    this.say("system", "Run resumed");
    p.resolve();
  }
  decide(gateId: string, decision: GateDecision) {
    const g = this.pendingGate;
    if (!g || g.req.id !== gateId) return false;
    this.pendingGate = null;
    this.emit({ type: "gate-closed", id: gateId, decision });
    g.resolve(decision);
    return true;
  }

  private async checkpoint() {
    if (this.abort.signal.aborted) throw new CancelledError();
    if (this.paused) await this.paused.promise;
    if (this.abort.signal.aborted) throw new CancelledError();
  }

  private async ask(req: Omit<GateRequest, "id">): Promise<GateDecision> {
    await this.checkpoint();
    const full: GateRequest = { ...req, id: `g${++this.gateSeq}` };
    const prev = this.status;
    this.setStatus("waiting");
    this.setAgent(req.agent, { activity: "waiting" });
    const decision = await new Promise<GateDecision>((resolve, reject) => {
      this.pendingGate = { req: full, resolve, reject };
      this.emit({ type: "gate", gate: full });
    });
    this.setStatus(prev === "waiting" ? "running" : "running");
    const word = decision.action === "approve" ? "approved" : decision.action === "reject" ? "rejected" : "commented on";
    this.say("system", `You ${word}: ${req.title}${decision.comment ? ` (“${decision.comment.slice(0, 120)}”)` : ""}`);
    return decision;
  }

  // ---------- the agent loop ----------
  private account(role: Role, usage: { prompt: number; completion: number }) {
    const usd = costOf(usage, this.config.pricing);
    const tokens = usage.prompt + usage.completion;
    this.usage.tokens += tokens;
    this.usage.usd += usd;
    this.agents[role].tokens += tokens;
    this.agents[role].cost += usd;
    this.emitCost();
    if (this.usage.usd > this.config.budgetUsd) throw new BudgetError(`Budget cap of $${this.config.budgetUsd.toFixed(2)} reached ($${this.usage.usd.toFixed(3)} spent)`);
  }

  private compactForHistory(call: ToolCall): string {
    const args = { ...call.args };
    if (typeof args.content === "string") args.content = `[${(args.content as string).length} chars written]`;
    if (typeof args.brief === "string" && (args.brief as string).length > 400) args.brief = (args.brief as string).slice(0, 400) + "…";
    return JSON.stringify({ thought: call.thought, tool: call.tool, args });
  }

  private async runAgent(role: Role, ctx: PhaseContext): Promise<ToolCall> {
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(role) }, { role: "user", content: phaseMessage(role, ctx) }];
    let invalid = 0;
    for (let step = 0; step < this.config.maxStepsPerAgent; step++) {
      await this.checkpoint();
      if (this.usage.usd >= this.config.budgetUsd) throw new BudgetError(`Budget cap of $${this.config.budgetUsd.toFixed(2)} reached`);
      this.setAgent(role, { activity: "working" });
      const res = await this.deps.llm.complete({ agent: role, messages, signal: this.abort.signal });
      this.account(role, res.usage);
      const parsed = parseToolCall(res.text, role);
      if (!parsed.ok) {
        invalid++;
        this.say(role, `invalid reply (${parsed.error}) — retrying`, "warn");
        if (invalid > 2) throw new AgentError(`${ROLE_INFO[role].name} produced ${invalid} invalid replies in a row: ${parsed.error}`);
        messages.push({ role: "assistant", content: res.text.slice(0, 2000) }, { role: "user", content: `ERROR: ${parsed.error} Reply with one valid JSON tool call.` });
        continue;
      }
      invalid = 0;
      const call = parsed.call;
      if (call.thought) { this.setAgent(role, { thought: call.thought }); this.say(role, call.thought); }
      messages.push({ role: "assistant", content: this.compactForHistory(call) });
      const result = await this.execTool(role, call);
      if (result.terminal) return call;
      messages.push({ role: "user", content: `TOOL RESULT (${call.tool}): ${result.text}` });
    }
    throw new AgentError(`${ROLE_INFO[role].name} did not finish within ${this.config.maxStepsPerAgent} steps`);
  }

  private shipFiles() {
    return Object.fromEntries(Object.entries(this.files).filter(([p]) => !p.startsWith("notes/")));
  }

  private codeProgress() {
    const mine = this.tickets.filter((t) => t.owner === "coder");
    if (mine.length) return Math.round((mine.filter((t) => t.status === "done").length / mine.length) * 100);
    return Math.min(90, Object.keys(this.shipFiles()).length * 25);
  }

  private async execTool(role: Role, call: ToolCall): Promise<{ terminal: boolean; text: string }> {
    const a = call.args as Record<string, string & unknown[]>;
    switch (call.tool) {
      case "write_file": {
        const path = safePath(String(a.path));
        if (!path) return { terminal: false, text: JSON.stringify({ ok: false, error: "invalid path (relative static-file paths only, no ..)" }) };
        if (role === "research" && !path.startsWith("notes/")) return { terminal: false, text: JSON.stringify({ ok: false, error: "research may only write under notes/" }) };
        const prev = this.files[path];
        this.files[path] = String(a.content);
        const touched = this.agents[role].filesTouched;
        if (!touched.includes(path)) touched.push(path);
        this.setAgent(role, { filesTouched: [...touched] });
        if (a.ticket) {
          const t = this.tickets.find((x) => x.id === a.ticket);
          if (t && t.status !== "done") { t.status = "done"; this.emit({ type: "tickets", tickets: this.tickets.map((x) => ({ ...x })) }); }
        }
        this.say(role, `${prev === undefined ? "wrote" : "updated"} ${path} (${(String(a.content).length / 1024).toFixed(1)} KB)`);
        this.emit({ type: "files", files: { ...this.files }, changed: [path], by: role });
        if (role === "coder") this.setStep("code", "active", this.codeProgress());
        return { terminal: false, text: JSON.stringify({ ok: true, path, bytes: String(a.content).length }) };
      }
      case "read_file": {
        const path = safePath(String(a.path));
        if (!path || !(path in this.files)) return { terminal: false, text: JSON.stringify({ ok: false, error: "file not found" }) };
        return { terminal: false, text: fence(`file ${path}`, this.files[path]) };
      }
      case "list_files":
        return { terminal: false, text: JSON.stringify(Object.entries(this.files).map(([p, s]) => ({ path: p, bytes: s.length }))) };
      case "run_checks": {
        const report = runChecks(this.shipFiles(), { sizeBudgetBytes: this.config.sizeBudgetBytes, syntax: this.deps.syntax });
        this.lastReport = report;
        this.say(role, `ran ${report.results.length} checks: ${report.ok ? "all pass" : `${report.failures} failing`}`, report.ok ? "info" : "warn");
        return { terminal: false, text: JSON.stringify({ ok: report.ok, failures: report.results.filter((r) => r.status !== "pass").map((r) => ({ check: r.label, status: r.status, details: r.details.slice(0, 6) })) }) };
      }
      case "ask_user": {
        const d = await this.ask({ kind: "question", agent: role, title: `${ROLE_INFO[role].name} asks`, body: String(a.question) });
        const answer = d.comment?.trim() || (d.action === "approve" ? "Yes, go ahead." : "No. Use your best judgement.");
        return { terminal: false, text: JSON.stringify({ answer }) };
      }
      case "handoff": {
        const to = String(a.to);
        if (!ROLE_NAMES.has(to)) return { terminal: false, text: JSON.stringify({ ok: false, error: "unknown role" }) };
        const expected = role === "reviewer" ? ["coder", "ops"] : [NEXT[role]];
        if (!expected.includes(to as Role)) return { terminal: false, text: JSON.stringify({ ok: false, error: `${role} hands off to ${expected.join(" or ")}` }) };
        return { terminal: true, text: "" };
      }
      case "finish":
        return { terminal: true, text: "" };
    }
  }

  private normalizeTickets(raw: unknown): Ticket[] {
    const list = Array.isArray(raw) ? raw : [];
    const out: Ticket[] = [];
    list.slice(0, 10).forEach((t, i) => {
      if (!t || typeof t !== "object") return;
      const o = t as Record<string, unknown>;
      const owner = ROLE_NAMES.has(String(o.owner)) ? (String(o.owner) as Role) : "coder";
      const title = String(o.title ?? "").slice(0, 120);
      if (title) out.push({ id: String(o.id ?? `T${i + 1}`).slice(0, 8), title, owner, status: "todo" });
    });
    if (!out.length) {
      return [
        { id: "T1", title: "Gather requirements and copy", owner: "research", status: "todo" },
        { id: "T2", title: "Build the page", owner: "coder", status: "todo" },
        { id: "T3", title: "Run checks", owner: "reviewer", status: "todo" },
        { id: "T4", title: "Deploy preview", owner: "ops", status: "todo" },
      ];
    }
    return out;
  }

  private closeTickets(owner: Role) {
    let changed = false;
    for (const t of this.tickets) if (t.owner === owner && t.status !== "done") { t.status = "done"; changed = true; }
    if (changed) this.emit({ type: "tickets", tickets: this.tickets.map((x) => ({ ...x })) });
  }
  private startTickets(owner: Role) {
    let changed = false;
    for (const t of this.tickets) if (t.owner === owner && t.status === "todo") { t.status = "doing"; changed = true; }
    if (changed) this.emit({ type: "tickets", tickets: this.tickets.map((x) => ({ ...x })) });
  }

  private async handoff(from: Role, to: Role, summary: string) {
    this.say(from, `→ ${ROLE_INFO[to].name}: ${summary}`);
    this.emit({ type: "handoff", from, to, summary });
    this.setAgent(from, { activity: "meeting" });
    this.setAgent(to, { activity: "meeting" });
    if (this.deps.pace?.handoff) await this.deps.pace.handoff(from, to, summary);
    await this.checkpoint();
    this.setAgent(from, { activity: "idle" });
  }

  private snapshot(label: string) {
    const s = { label, files: { ...this.shipFiles() } };
    this.snapshots.push(s);
    this.emit({ type: "snapshot", snapshot: s });
  }

  /** Real offending lines for the approval card: "-" = line that fails a check, "+" = reviewer's suggested fix. */
  private reviewDiff(report: CheckReport, fixes: string[]): DiffLine[] {
    const out: DiffLine[] = [];
    const files = this.shipFiles();
    for (const r of report.results.filter((x) => x.status === "fail")) {
      for (const d of r.details.slice(0, 2)) {
        const m = d.match(/^([^:\s]+):\s.*?(?:"([^"]+)"|<img src="([^"]+)")/);
        const file = m?.[1];
        const needle = m?.[2] ?? m?.[3];
        const line = file && needle && files[file]?.split("\n").find((l) => l.includes(needle));
        if (line) out.push({ type: "del", text: line.trim().slice(0, 90) });
      }
    }
    for (const f of fixes.slice(0, 3)) out.push({ type: "add", text: f.slice(0, 90) });
    return out.slice(0, 6);
  }

  private latestDiff(): DiffLine[] | undefined {
    if (this.snapshots.length < 2) return undefined;
    const a = this.snapshots[this.snapshots.length - 2].files;
    const b = this.snapshots[this.snapshots.length - 1].files;
    for (const p of Object.keys(b)) {
      if (a[p] !== b[p]) {
        const d = compactDiff(lineDiff(a[p] ?? "", b[p]), 0).filter((l) => l.text !== "…");
        if (d.length) return d.slice(0, 6).map((l) => ({ ...l, text: l.text.trim().slice(0, 90) }));
      }
    }
    return undefined;
  }

  // ---------- pipeline ----------
  async run(): Promise<RunStatus> {
    const cfg = this.config;
    this.setStatus("running");
    this.say("system", `Task started: ${cfg.task}`);
    try {
      // PLAN
      this.setStep("plan", "active");
      let feedback: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const call = await this.runAgent("pm", { task: cfg.task, notes: cfg.notes, tickets: [], files: {}, feedback });
        this.tickets = this.normalizeTickets(call.args.tickets);
        this.emit({ type: "tickets", tickets: this.tickets.map((x) => ({ ...x })) });
        this.say("pm", `split the task into ${this.tickets.length} tickets`);
        this.setAgent("pm", { activity: "whiteboard" });
        if (this.deps.pace?.tickets) await this.deps.pace.tickets(this.tickets);
        if (!cfg.gates.plan) break;
        const d = await this.ask({ kind: "plan", agent: "pm", title: `PM wants to start with ${this.tickets.length} tickets`, body: String(call.args.summary ?? ""), items: this.tickets.map((t) => `${t.id} · ${ROLE_INFO[t.owner].name} · ${t.title}`) });
        if (d.action === "reject" && attempt < 2) { feedback = d.comment || "Rethink the plan: make it simpler and more concrete."; continue; }
        feedback = d.action === "comment" ? d.comment : undefined;
        break;
      }
      this.setStep("plan", "done");
      await this.handoff("pm", "research", `${this.tickets.length} tickets on the board — start with requirements and copy.`);

      // RESEARCH
      this.setStep("research", "active");
      this.startTickets("research");
      let refText: string | undefined;
      if (cfg.refUrl && this.deps.fetchRef) {
        try {
          refText = await this.deps.fetchRef(cfg.refUrl, this.abort.signal);
          this.say("research", `fetched ${cfg.refUrl} (${(refText.length / 1024).toFixed(1)} KB, treated as data)`);
        } catch (e) {
          this.say("research", `could not fetch ${cfg.refUrl}: ${(e as Error).message}`, "warn");
        }
      }
      const rcall = await this.runAgent("research", { task: cfg.task, notes: cfg.notes, refText, refUrl: cfg.refUrl, tickets: this.tickets, files: this.files, feedback });
      this.brief = String(rcall.args.brief ?? this.files["notes/brief.md"] ?? "");
      this.closeTickets("research");
      this.setStep("research", "done");
      await this.handoff("research", "coder", String(rcall.args.summary));

      // CODE ⇄ REVIEW
      let round = 0;
      let report: CheckReport | null = null;
      let reviewFeedback: string | undefined = feedback;
      for (;;) {
        this.setStep("code", "active", round ? 50 : this.codeProgress());
        this.startTickets("coder");
        const ccall = await this.runAgent("coder", { task: cfg.task, tickets: this.tickets, brief: this.brief, files: this.files, report: round ? report ?? undefined : undefined, round, feedback: reviewFeedback });
        this.closeTickets("coder");
        this.snapshot(round === 0 ? "Coder v1" : `Coder v${round + 1} (fix round ${round})`);
        this.setStep("code", "done", 100);
        await this.handoff("coder", "reviewer", String(ccall.args.summary));

        this.setStep("review", "active");
        this.startTickets("reviewer");
        this.lastReport = null;
        const vcall = await this.runAgent("reviewer", { task: cfg.task, tickets: this.tickets, brief: this.brief, files: this.files });
        report = this.lastReport ?? runChecks(this.shipFiles(), { sizeBudgetBytes: cfg.sizeBudgetBytes, syntax: this.deps.syntax });
        this.lastReport = report;
        this.emit({ type: "checks", report, round });
        if (report.ok) {
          this.closeTickets("reviewer");
          this.setStep("review", "done");
          await this.handoff("reviewer", "ops", String(vcall.args.summary || "All checks pass."));
          break;
        }
        const fixes = Array.isArray(vcall.args.fixes) ? (vcall.args.fixes as unknown[]).map(String) : [];
        this.say("reviewer", `${report.failures} check${report.failures > 1 ? "s" : ""} failing: ${report.results.filter((r) => r.status === "fail").map((r) => r.label.toLowerCase()).join(", ")}`, "warn");
        if (round >= cfg.maxReviewRounds) {
          this.say("reviewer", `still failing after ${round} fix round${round > 1 ? "s" : ""}; stopping the loop`, "warn");
          if (cfg.gates.review) {
            const d = await this.ask({ kind: "review", agent: "reviewer", title: `Reviewer: ${report.failures} still failing after ${round} rounds, deploy anyway?`, body: summarizeReport(report), items: report.results.filter((r) => r.status === "fail").flatMap((r) => r.details.slice(0, 3)) });
            if (d.action === "reject") throw new AgentError("Stopped: checks still failing and deploy was rejected");
          }
          this.setStep("review", "failed");
          await this.handoff("reviewer", "ops", "Shipping with known failures (see the review report).");
          break;
        }
        if (cfg.gates.review) {
          const d = await this.ask({
            kind: "review", agent: "reviewer",
            title: `Reviewer: ${report.failures} test${report.failures > 1 ? "s" : ""} failing, fix before deploy?`,
            body: String(vcall.args.summary ?? ""),
            items: report.results.filter((r) => r.status === "fail").flatMap((r) => r.details.slice(0, 3)),
            diff: this.reviewDiff(report, fixes),
          });
          if (d.action === "reject") {
            this.say("reviewer", "fixes skipped by you; shipping as is", "warn");
            this.setStep("review", "failed");
            await this.handoff("reviewer", "ops", "Fixes skipped, shipping as is.");
            break;
          }
          reviewFeedback = [fixes.length ? `Reviewer's fixes: ${fixes.join("; ")}` : "", d.comment ?? ""].filter(Boolean).join(" ") || undefined;
        } else {
          reviewFeedback = fixes.length ? `Reviewer's fixes: ${fixes.join("; ")}` : undefined;
        }
        round++;
        await this.handoff("reviewer", "coder", String(vcall.args.summary || `${report.failures} checks failing`));
      }

      // DEPLOY
      this.setStep("deploy", "active");
      this.startTickets("ops");
      const ocall = await this.runAgent("ops", { task: cfg.task, tickets: this.tickets, files: this.files });
      const ship = this.shipFiles();
      const n = Object.keys(ship).length;
      let deployed = true;
      if (cfg.gates.deploy) {
        const d = await this.ask({
          kind: "deploy", agent: "ops",
          title: `Ops wants to deploy ${n} file${n > 1 ? "s" : ""} to preview${this.deps.push ? " and push to GitHub" : ""}`,
          body: String(ocall.args.summary ?? ""),
          items: Object.entries(ship).map(([p, s]) => `${p} · ${(s.length / 1024).toFixed(1)} KB`),
          diff: this.latestDiff(),
        });
        if (d.action === "reject") deployed = false;
      }
      if (deployed && this.deps.deploy) {
        const r = await this.deps.deploy(this.deps.runId, ship);
        this.deployedUrl = r.url;
        this.say("ops", `deployed preview → ${r.local ? "local preview" : r.url}`);
        this.emit({ type: "deployed", url: r.url, local: r.local });
        if (this.deps.push) {
          try {
            const p = await this.deps.push(ship);
            this.say("ops", `pushed to GitHub → ${p.url}`);
            this.emit({ type: "pushed", url: p.url });
          } catch (e) {
            this.say("ops", `GitHub push failed: ${(e as Error).message}`, "error");
          }
        }
        this.closeTickets("ops");
        this.setStep("deploy", "done");
      } else {
        this.say("ops", deployed ? "no deploy target configured; files are ready to download" : "deploy rejected; files are ready to download as ZIP", "warn");
        this.setStep("deploy", "skipped");
      }
      this.summary = `${n} files, ${(Object.values(ship).reduce((s, x) => s + x.length, 0) / 1024).toFixed(1)} KB, ${this.lastReport?.ok ? "all checks pass" : "with failing checks"}`;
      for (const r of ROLES) this.setAgent(r, { activity: "idle" });
      this.say("system", `Done: ${this.summary} · $${this.usage.usd.toFixed(3)} · ${this.usage.tokens.toLocaleString("en-US")} tokens`);
      this.emit({ type: "done", summary: this.summary });
      this.setStatus("done");
    } catch (e) {
      for (const r of ROLES) this.setAgent(r, { activity: "idle" });
      const err = e as Error;
      this.error = err.message;
      if (err instanceof CancelledError || (err.name === "AbortError" && this.abort.signal.aborted)) {
        this.say("system", "Run cancelled", "warn");
        this.setStatus("cancelled");
      } else if (err instanceof BudgetError) {
        this.say("system", err.message, "error");
        this.setStatus("budget");
      } else {
        this.say("system", `Run failed: ${err.message}`, "error");
        this.setStatus("failed");
      }
      for (const id of Object.keys(this.steps) as StepId[]) if (this.steps[id].state === "active") this.setStep(id, "failed");
    }
    return this.status;
  }
}
