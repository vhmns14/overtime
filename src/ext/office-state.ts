// The external-agent office as a pure reducer: events in, per-session state plus a list of office
// "effects" (walk to a desk and type, hand off at the table, stick plans on the whiteboard, wait for
// approval) out. The live view, the recorded demo and the tests all drive this same code.

import { ROLES, ROLE_INFO, STEPS, type AgentState, type LogEntry, type Role, type StepId, type StepState, type Ticket } from "../engine/types";
import type { EventData, ExtEvent } from "./schema";
import { DEFAULT_RULES, roleFor, type RoleRule } from "./roles";
import { costOf, type Price } from "./pricing";
import { applyLibrary, newLibrary, type LibraryState } from "./library";
import { applyOutcome, newScoreboard, type Scoreboard } from "./scoreboard";

export type Effect =
  | { k: "work"; role: Role; on: boolean; say?: string }
  | { k: "pulse"; role: Role; say?: string }
  | { k: "say"; role: Role; text: string; kind?: "talk" | "think" }
  | { k: "handoff"; from: Role; to: Role; text: string }
  | { k: "whiteboard"; tickets: Ticket[] }
  | { k: "tickets"; tickets: Ticket[] }
  | { k: "wait"; role: Role; text: string }
  | { k: "clear-wait" }
  | { k: "tag"; role: Role; text: string | null }
  | { k: "idle-all" }
  | { k: "session"; id: string }
  // office reactions (office-wide, whichever session is on screen)
  | { k: "skill"; name: string; change: "added" | "improved" | "used" | "removed" | "restored"; versions: number }
  | { k: "memory"; op: "write" | "recall" }
  | { k: "outcome"; ok: boolean };

export interface SubagentView { id: string; name: string; desk: Role; status: "running" | "done" | "failed"; startedAt: number; goal?: string }
export interface PendingInput { kind: "approval" | "clarify" | "sudo" | "input"; text: string; detail?: string; at: number; role: Role }

export interface SessionView {
  id: string;
  title: string;
  model?: string;
  platform?: string;
  profile?: string;
  startedAt: number;
  lastAt: number;
  status: "working" | "idle" | "waiting" | "ended";
  steps: Record<StepId, { state: StepState; pct?: number; note?: string }>;
  agents: Record<Role, AgentState & { name: string }>;
  tickets: Ticket[];
  log: LogEntry[];
  files: string[];
  cost: { usd: number; tokens: number; calls: number; byAgent: Record<Role, { tokens: number; usd: number }>; unpriced: string[] };
  subagents: Record<string, SubagentView>;
  pending: PendingInput | null;
  lastRole: Role;
  lastHandoffAt: number;
  openTools: Record<string, { name: string; role: Role; at: number }>;
  counts: Record<string, number>;
}

export interface OfficeState {
  sessions: Record<string, SessionView>;
  order: string[];
  /** child session id → { parent session, subagent id } (Hermes subagents run in their own session) */
  children: Record<string, { parent: string; id: string }>;
  lastSeq: number;
  rules: RoleRule[];
  fallbackPrice: Price | null;
  /** Hermes' skills (books on the shelf) and memory activity, across all sessions */
  library: LibraryState;
  /** today's sessions: succeeded vs failed */
  board: Scoreboard;
}

const STEP_OF: Record<Role, StepId> = { pm: "plan", research: "research", coder: "code", reviewer: "review", ops: "deploy" };
const LOG_MAX = 300;
const HANDOFF_GAP_MS = 12_000;

export function newOffice(rules: RoleRule[] = DEFAULT_RULES, fallbackPrice: Price | null = null): OfficeState {
  return { sessions: {}, order: [], children: {}, lastSeq: 0, rules, fallbackPrice, library: newLibrary(), board: newScoreboard() };
}

function blankAgents(): SessionView["agents"] {
  return Object.fromEntries(ROLES.map((r) => [r, { role: r, name: ROLE_INFO[r].name, activity: "idle", thought: "", log: [], filesTouched: [], tokens: 0, cost: 0 }])) as unknown as SessionView["agents"];
}

export function newSession(id: string, at: number): SessionView {
  return {
    id, title: "Hermes session", startedAt: at, lastAt: at, status: "idle",
    steps: Object.fromEntries(STEPS.map((s) => [s.id, { state: "pending" as StepState }])) as SessionView["steps"],
    agents: blankAgents(), tickets: [], log: [], files: [],
    cost: { usd: 0, tokens: 0, calls: 0, byAgent: Object.fromEntries(ROLES.map((r) => [r, { tokens: 0, usd: 0 }])) as SessionView["cost"]["byAgent"], unpriced: [] },
    subagents: {}, pending: null, lastRole: "pm", lastHandoffAt: 0, openTools: {}, counts: {},
  };
}

function session(st: OfficeState, id: string, at: number): SessionView {
  let s = st.sessions[id];
  if (!s) {
    s = st.sessions[id] = newSession(id, at);
    st.order.push(id);
    if (st.order.length > 60) {
      const drop = st.order.shift()!;
      delete st.sessions[drop];
    }
  }
  return s;
}

const short = (s: string, n = 56) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmtMs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function log(s: SessionView, e: ExtEvent, agent: Role | "system", text: string, level: LogEntry["level"] = "info") {
  const name = agent !== "system" ? s.agents[agent].name : undefined;
  s.log.push({ t: e.ts, agent, text, level, ...(name && agent !== "system" && name !== ROLE_INFO[agent].name ? { name } : {}) });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  if (agent !== "system") {
    const a = s.agents[agent];
    a.log.push(text);
    if (a.log.length > 12) a.log.shift();
  }
}

function activate(s: SessionView, role: Role) {
  const id = STEP_OF[role];
  for (const st of STEPS) if (s.steps[st.id].state === "active" && st.id !== id) s.steps[st.id].state = "done";
  s.steps[id].state = "active";
}

/** "/home/me/projects/api/app/main.py" → "…/app/main.py" for logs and bubbles. */
export function shortPath(p: string): string {
  if (!p.startsWith("/") && !p.startsWith("~")) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : p;
}

function toolLabel(d: { name: string; target?: string; args_summary?: string }) {
  const t = d.target ? shortPath(d.target) : d.args_summary ? d.args_summary.replace(/(^|\s|=)(\/[^\s]+)/g, (_m, a: string, p: string) => a + shortPath(p)) : "";
  return short(`${d.name}${t ? ` ${t}` : ""}`, 64);
}

/** Lends a free desk to a subagent: research, coder, reviewer, ops in that order; the PM stays with the main agent. */
function pickDesk(s: SessionView): Role {
  const lent = new Set(Object.values(s.subagents).filter((x) => x.status === "running").map((x) => x.desk));
  for (const r of ["research", "coder", "reviewer", "ops"] as Role[]) if (!lent.has(r)) return r;
  // all four lent: share the desk of the oldest running subagent
  return Object.values(s.subagents).filter((x) => x.status === "running").sort((a, b) => a.startedAt - b.startedAt)[0]?.desk ?? "research";
}

function deskOwner(s: SessionView, role: Role): SubagentView | undefined {
  return Object.values(s.subagents).find((x) => x.status === "running" && x.desk === role);
}

/**
 * Applies one stored event. Returns the effects for the office scene; they matter only when the
 * event's session is the one on screen (the caller decides).
 */
export function applyEvent(st: OfficeState, raw: ExtEvent): { session: string; effects: Effect[] } {
  if (raw.seq) st.lastSeq = Math.max(st.lastSeq, raw.seq);
  // attribute events from a subagent's own session to the parent session + that subagent
  let e = raw;
  const child = st.children[raw.session];
  if (child) e = { ...raw, session: child.parent, agent: child.id };
  // a subagent's own session lifecycle is not a new office session: subagent.start/stop cover it
  if (child && (e.type === "session.start" || e.type === "session.end")) return { session: child.parent, effects: [] };
  const s = session(st, e.session, e.ts);
  const fx: Effect[] = [];
  s.lastAt = Math.max(s.lastAt, e.ts);
  s.counts[e.type] = (s.counts[e.type] ?? 0) + 1;
  const sub = e.agent !== "main" ? s.subagents[e.agent] : undefined;

  // which character?
  let role: Role;
  if (sub) role = sub.desk;
  else {
    role = roleFor(e, st.rules) ?? s.lastRole;
    if (deskOwner(s, role)) role = "pm"; // that desk is lent to a subagent: the main agent's work shows at the PM's desk
  }
  const d = e.data as Record<string, unknown>;
  const wasEnded = s.status === "ended" || s.status === "idle";

  const touch = (r: Role) => {
    if (s.status !== "waiting") s.status = "working";
    activate(s, r);
    if (!sub && r !== s.lastRole) {
      const prev = s.lastRole;
      if (!wasEnded && e.ts - s.lastHandoffAt >= HANDOFF_GAP_MS && !deskOwner(s, prev)) {
        s.lastHandoffAt = e.ts;
        fx.push({ k: "handoff", from: prev, to: r, text: handoffLine(e) });
      }
      s.lastRole = r;
    }
  };

  switch (e.type) {
    case "session.start": {
      const x = d as EventData["session.start"];
      Object.assign(s, { model: x.model ?? s.model, platform: x.platform ?? s.platform, profile: x.profile ?? s.profile });
      if (x.title) s.title = x.title;
      else if (x.platform) s.title = `Hermes · ${x.platform}`;
      s.startedAt = Math.min(s.startedAt, e.ts);
      s.status = "idle";
      log(s, e, "system", `Session started${x.model ? ` · ${x.model}` : ""}${x.platform ? ` · ${x.platform}` : ""}`);
      fx.push({ k: "session", id: s.id });
      break;
    }
    case "session.end": {
      const x = d as EventData["session.end"];
      s.status = x.final ? "ended" : "idle";
      s.pending = null;
      for (const stp of STEPS) if (s.steps[stp.id].state === "active") s.steps[stp.id].state = x.status === "failed" ? "failed" : "done";
      s.openTools = {};
      for (const r of ROLES) s.agents[r].activity = "idle";
      log(s, e, "system", x.final ? "Session closed" : x.status === "interrupted" ? "Turn interrupted" : x.status === "failed" ? "Turn failed" : "Turn finished, waiting for the next message", x.status === "failed" ? "error" : "info");
      fx.push({ k: "clear-wait" }, { k: "idle-all" });
      if (x.status === "completed" && !x.final) fx.push({ k: "say", role: "pm", text: "Done. Waiting for the next message.", kind: "talk" });
      applyOutcome(st.board, e);
      if (!x.final && x.status !== "interrupted") fx.push({ k: "outcome", ok: x.status !== "failed" });
      break;
    }
    case "agent.thinking": {
      const x = d as EventData["agent.thinking"];
      touch(role);
      s.agents[role].thought = x.text ?? "Thinking…";
      s.agents[role].activity = "working";
      fx.push({ k: "pulse", role, say: x.text && !/^Calling /.test(x.text) ? short(x.text, 60) : undefined });
      if (x.text && !/^(Calling |Replied$)/.test(x.text)) log(s, e, role, short(x.text, 160));
      break;
    }
    case "llm.call": {
      const x = d as EventData["llm.call"];
      const inp = x.input_tokens ?? 0, out = x.output_tokens ?? 0, cr = x.cache_read_tokens ?? 0, cw = x.cache_write_tokens ?? 0;
      const tokens = inp + out + cr + cw;
      let usd = x.cost_usd ?? costOf(x.model, inp + cw, out, cr, st.fallbackPrice);
      if (usd === null) {
        usd = 0;
        if (x.model && !s.cost.unpriced.includes(x.model)) s.cost.unpriced.push(x.model);
      }
      s.cost.usd += usd;
      s.cost.tokens += tokens;
      s.cost.calls += 1;
      s.cost.byAgent[role].tokens += tokens;
      s.cost.byAgent[role].usd += usd;
      s.agents[role].tokens += tokens;
      s.agents[role].cost += usd;
      if (x.model) s.model = s.model ?? x.model;
      touch(role);
      s.agents[role].thought = x.tool_calls ? `Decided on ${x.tool_calls} tool call${x.tool_calls === 1 ? "" : "s"}` : "Wrote a reply";
      fx.push({ k: "pulse", role });
      log(s, e, role, `model call · ${fmtTok(inp + cr + cw)} in / ${fmtTok(out)} out${usd ? ` · $${usd.toFixed(4)}` : ""}${x.duration_ms ? ` · ${fmtMs(x.duration_ms)}` : ""}`);
      break;
    }
    case "tool.start": {
      const x = d as EventData["tool.start"];
      const key = x.call_id ?? `${x.name}:${e.seq}`;
      if (x.call_id && s.openTools[x.call_id]) break; // pre_tool_call and post_api_request may both announce it
      s.openTools[key] = { name: x.name, role, at: e.ts };
      touch(role);
      const label = toolLabel(x);
      s.agents[role].thought = label;
      s.agents[role].activity = "working";
      fx.push({ k: "work", role, on: true, say: label });
      log(s, e, role, `→ ${label}`);
      break;
    }
    case "tool.end": {
      const x = d as EventData["tool.end"];
      let open = x.call_id ? s.openTools[x.call_id] : undefined;
      if (!open) {
        const k = Object.keys(s.openTools).find((k2) => s.openTools[k2].name === x.name);
        if (k) { open = s.openTools[k]; delete s.openTools[k]; }
      } else delete s.openTools[x.call_id!];
      const r = open?.role ?? role;
      touch(r);
      const label = toolLabel(x);
      const still = Object.values(s.openTools).some((t) => t.role === r);
      if (!still) s.agents[r].activity = "idle";
      if (open) fx.push({ k: "work", role: r, on: still });
      else fx.push({ k: "pulse", role: r, say: label });
      log(s, e, r, `${x.ok ? "✓" : "✗"} ${label}${x.duration_ms !== undefined ? ` · ${fmtMs(x.duration_ms)}` : ""}${!x.ok && x.error ? ` · ${short(x.error, 80)}` : ""}`, x.ok ? "info" : "warn");
      break;
    }
    case "file.write": {
      const x = d as EventData["file.write"];
      if (!s.files.includes(x.path)) s.files.push(x.path);
      if (s.files.length > 200) s.files.shift();
      const r = sub ? sub.desk : deskOwner(s, "coder") ? "pm" : "coder";
      const a = s.agents[r];
      if (!a.filesTouched.includes(x.path)) a.filesTouched.push(x.path);
      s.steps.code.note = `${s.files.length} file${s.files.length === 1 ? "" : "s"}`;
      log(s, e, r, `${x.op === "delete" ? "deleted" : x.op === "write" || !x.op ? "wrote" : "edited"} ${shortPath(x.path)}`);
      break;
    }
    case "plan.update": {
      const x = d as EventData["plan.update"];
      const tickets: Ticket[] = x.items.filter((i) => i.status !== "cancelled").slice(0, 12).map((i, n) => ({ id: i.id ?? `t${n + 1}`, title: i.text, owner: guessOwner(i.text, st.rules), status: i.status === "done" ? "done" : i.status === "doing" ? "doing" : "todo" }));
      const fresh = tickets.length !== s.tickets.length || tickets.some((t, i) => t.title !== s.tickets[i]?.title);
      s.tickets = tickets;
      touch("pm");
      const done = tickets.filter((t) => t.status === "done").length;
      s.steps.plan.note = `${done}/${tickets.length}`;
      fx.push(fresh ? { k: "whiteboard", tickets } : { k: "tickets", tickets });
      log(s, e, "pm", fresh ? `plan: ${tickets.length} item${tickets.length === 1 ? "" : "s"} on the whiteboard` : `plan: ${done}/${tickets.length} done`);
      break;
    }
    case "subagent.start": {
      const x = d as EventData["subagent.start"];
      if (s.subagents[x.id]?.status === "running") break;
      const desk = pickDesk(s);
      const shared = deskOwner(s, desk);
      const name = short(x.name ?? "Subagent", 22);
      s.subagents[x.id] = { id: x.id, name, desk, status: "running", startedAt: e.ts, goal: x.goal };
      if (x.child_session) st.children[x.child_session] = { parent: s.id, id: x.id };
      st.children[x.id] = st.children[x.id] ?? { parent: s.id, id: x.id };
      s.agents[desk].name = shared ? `${shared.name} +1` : name;
      s.agents[desk].thought = x.goal ? short(x.goal, 120) : "Working on a delegated task";
      touch("pm");
      fx.push({ k: "tag", role: desk, text: s.agents[desk].name }, { k: "handoff", from: "pm", to: desk, text: x.goal ? short(x.goal, 60) : `Over to you, ${name}` });
      s.lastHandoffAt = e.ts;
      log(s, e, "pm", `delegated to subagent “${name}”${x.goal ? `: ${short(x.goal, 100)}` : ""}`);
      break;
    }
    case "subagent.stop": {
      const x = d as EventData["subagent.stop"];
      const sa = s.subagents[x.id];
      if (!sa || sa.status !== "running") break;
      sa.status = x.status && /fail|error|timeout/i.test(x.status) ? "failed" : "done";
      const desk = sa.desk;
      const still = deskOwner(s, desk);
      s.agents[desk].name = still ? still.name : ROLE_INFO[desk].name;
      s.agents[desk].activity = "idle";
      fx.push({ k: "handoff", from: desk, to: "pm", text: x.summary ? short(x.summary, 60) : sa.status === "done" ? "Done, here is what I found" : "I could not finish" }, { k: "tag", role: desk, text: still ? still.name : null });
      s.lastHandoffAt = e.ts;
      log(s, e, desk, `subagent “${sa.name}” ${sa.status === "done" ? "finished" : `stopped (${x.status})`}${x.duration_ms ? ` · ${fmtMs(x.duration_ms)}` : ""}${x.tools !== undefined ? ` · ${x.tools} tool calls` : ""}`, sa.status === "done" ? "info" : "warn");
      break;
    }
    case "approval.request": {
      const x = d as EventData["approval.request"];
      const who = Object.values(s.openTools).at(-1)?.role ?? (role === "pm" ? s.lastRole : role);
      s.pending = { kind: "approval", text: x.description ?? "A command needs approval", detail: x.command, at: e.ts, role: who };
      s.status = "waiting";
      s.agents[who].activity = "waiting";
      fx.push({ k: "wait", role: who, text: "Waiting for approval in Hermes" });
      log(s, e, who, `asked for approval: ${short(x.description ?? x.pattern ?? "dangerous command", 100)}`, "warn");
      break;
    }
    case "approval.response": {
      const x = d as EventData["approval.response"];
      const who = s.pending?.role ?? role;
      s.pending = null;
      s.status = "working";
      s.agents[who].activity = "idle";
      fx.push({ k: "clear-wait" });
      log(s, e, who, `approval: ${x.choice ?? "answered"}`, x.choice === "deny" || x.choice === "timeout" ? "warn" : "info");
      break;
    }
    case "human_input.request": {
      const x = d as EventData["human_input.request"];
      if (x.kind === "approval") break; // the approval hooks carry the details
      const kind = x.kind === "clarify" ? "clarify" : x.kind === "sudo" ? "sudo" : "input";
      s.pending = { kind, text: kind === "clarify" ? "Hermes asked you a question" : kind === "sudo" ? "Hermes needs your sudo password" : "Hermes is waiting for your input", detail: x.prompt, at: e.ts, role: "pm" };
      s.status = "waiting";
      fx.push({ k: "wait", role: "pm", text: kind === "clarify" ? "Asked you a question in Hermes" : "Waiting for you in Hermes" });
      log(s, e, "pm", s.pending.text, "warn");
      break;
    }
    case "human_input.resolved": {
      if (s.pending && s.pending.kind !== "approval") {
        s.pending = null;
        s.status = "working";
        fx.push({ k: "clear-wait" });
        log(s, e, "pm", `input ${(d as EventData["human_input.resolved"]).outcome ?? "received"}`);
      }
      break;
    }
    case "message": {
      const x = d as EventData["message"];
      if (x.role === "user") {
        if (s.title === "Hermes session" || /^Hermes · /.test(s.title)) s.title = short(x.text.replace(/\s+/g, " "), 60);
        log(s, e, "system", `You: ${short(x.text, 200)}`);
      } else {
        touch("pm");
        log(s, e, "pm", short(x.text, 200));
        fx.push({ k: "say", role: "pm", text: short(x.text, 60), kind: "talk" });
      }
      break;
    }
    case "skill.update": {
      const x = d as EventData["skill.update"];
      const lf = applyLibrary(st.library, e);
      if (lf?.k === "book") {
        fx.push({ k: "skill", name: lf.name, change: lf.change, versions: lf.versions });
        if (lf.change !== "used") log(s, e, "pm", `skill “${short(x.name, 60)}” ${lf.change === "added" ? (lf.versions > 1 ? `on the shelf · v${lf.versions}` : "created: a new book on the shelf") : lf.change === "improved" ? `improved · v${lf.versions}` : lf.change}`);
      }
      break;
    }
    case "memory.write":
    case "memory.recall": {
      const lf = applyLibrary(st.library, e);
      if (lf?.k === "cabinet") {
        fx.push({ k: "memory", op: lf.op });
        const t = (d as EventData["memory.write"]).target;
        log(s, e, "pm", lf.op === "write" ? `memory ${(d as EventData["memory.write"]).action ?? "write"}${t === "user" ? " · user profile" : ""}` : "recalled past sessions");
      }
      break;
    }
    case "error": {
      const x = d as EventData["error"];
      log(s, e, role, short(x.message, 160), "error");
      fx.push({ k: "say", role, text: "Hit an error", kind: "talk" });
      break;
    }
  }
  return { session: s.id, effects: fx };
}

function handoffLine(e: ExtEvent): string {
  const d = e.data as Record<string, unknown>;
  if (e.type === "tool.start" || e.type === "tool.end") return short(`${d.name}${d.target ? ` ${d.target}` : ""}`, 48);
  if (e.type === "file.write") return short(`edit ${d.path}`, 48);
  return "Your turn";
}

function guessOwner(text: string, rules: RoleRule[]): Role {
  const t = text.toLowerCase();
  if (/\b(test|verify|lint|check|review)\b/.test(t)) return "reviewer";
  if (/\b(deploy|push|release|docker|cron|ship)\b/.test(t)) return "ops";
  if (/\b(research|search|read|look up|investigate|docs?)\b/.test(t)) return "research";
  if (/\b(write|implement|add|fix|edit|refactor|create|build|code)\b/.test(t)) return "coder";
  void rules;
  return "pm";
}

/** Replays a list of events into a fresh office (late viewers, tests). */
export function replay(events: ExtEvent[], rules?: RoleRule[], fallback?: Price | null): OfficeState {
  const st = newOffice(rules, fallback ?? null);
  for (const e of events) applyEvent(st, e);
  return st;
}

/** The session the office should show when following: the newest one by activity. */
export function latestSession(st: OfficeState): string | null {
  let best: SessionView | null = null;
  for (const id of st.order) {
    const s = st.sessions[id];
    if (!best || s.lastAt >= best.lastAt) best = s;
  }
  return best?.id ?? null;
}
