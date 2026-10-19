// Aggregations over stored events: per-session stats (the summary card), and cost/tokens per day,
// per model and per session (the cost dashboard). Pure and deterministic: time zones come in as an
// offset so tests do not depend on the machine.

import type { EventData, ExtEvent, PlanItem } from "../ext/schema";
import { costOf, type Price } from "../ext/pricing";
import { attribute, sortEvents } from "./sessions";

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number }
export interface ToolStat { name: string; count: number; fails: number; totalMs: number }
export interface FileStat { path: string; op: string; count: number; added: number; removed: number }
export interface SessionStats {
  id: string;
  title: string;
  platform?: string;
  models: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: "open" | "completed" | "interrupted" | "failed" | "closed";
  usd: number;
  tokens: Tokens;
  calls: number;
  unpriced: string[];
  tools: ToolStat[];
  errors: { ts: number; text: string; source: string }[];
  files: FileStat[];
  subagents: { id: string; name: string; status: string; goal?: string; summary?: string }[];
  approvals: { text: string; choice?: string }[];
  plan: PlanItem[];
  tests: { label: string; ok: boolean }[];
  userMessage?: string;
  finalMessage?: string;
  events: number;
}

export function emptyTokens(): Tokens { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }; }

/** Cost and tokens of one llm.call, priced the same way as the office reducer. usd is null when the model has no known price. */
export function llmCost(d: EventData["llm.call"], fallback: Price | null = null): { usd: number | null; tokens: Tokens } {
  const t: Tokens = { input: d.input_tokens ?? 0, output: d.output_tokens ?? 0, cacheRead: d.cache_read_tokens ?? 0, cacheWrite: d.cache_write_tokens ?? 0, reasoning: d.reasoning_tokens ?? 0, total: 0 };
  t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
  const usd = d.cost_usd ?? costOf(d.model, t.input + t.cacheWrite, t.output, t.cacheRead, fallback);
  return { usd, tokens: t };
}

/** A tool call that ran but whose output says checks failed (Hermes reports `terminal` as ok when the command ran). */
export function outputFailed(d: { output_summary?: string }): boolean {
  return !!d.output_summary && /\b[1-9]\d* (failed|failures?|errors?)\b|\bFAILED\b|^Traceback|\bnpm ERR!/m.test(d.output_summary);
}

const TEST_RE = /\b(pytest|vitest|jest|mocha|npm (run )?test|pnpm test|yarn test|go test|cargo test|ruff|eslint|tsc|mypy|flake8|unittest|phpunit|rspec)\b/i;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Stats for one session; `events` may hold the whole office (other sessions are ignored). */
export function sessionStats(events: readonly ExtEvent[], id: string, fallback: Price | null = null): SessionStats {
  const list = sortEvents(attribute(events).filter((e) => e.session === id));
  const s: SessionStats = {
    id, title: "Hermes session", models: [], startedAt: list[0]?.ts ?? 0, endedAt: list.at(-1)?.ts ?? 0, durationMs: 0, status: "open",
    usd: 0, tokens: emptyTokens(), calls: 0, unpriced: [], tools: [], errors: [], files: [], subagents: [], approvals: [], plan: [], tests: [], events: list.length,
  };
  const tools = new Map<string, ToolStat>();
  const files = new Map<string, FileStat>();
  const started = new Map<string, { name: string; target?: string; args?: string }>();
  const subs = new Map<string, SessionStats["subagents"][number]>();
  let pendingApproval: { text: string; choice?: string } | null = null;
  let titled = false;
  for (const e of list) {
    switch (e.type) {
      case "session.start": {
        const d = e.data as EventData["session.start"];
        if (d.title) { s.title = d.title; titled = true; } else if (d.platform && !titled) s.title = `Hermes · ${d.platform}`;
        if (d.platform) s.platform = d.platform;
        if (d.model && !s.models.includes(d.model)) s.models.push(d.model);
        if (s.status !== "closed") s.status = "open";
        break;
      }
      case "session.end": {
        const d = e.data as EventData["session.end"];
        s.status = d.final ? "closed" : d.status ?? "completed";
        break;
      }
      case "llm.call": {
        const d = e.data as EventData["llm.call"];
        const c = llmCost(d, fallback);
        s.calls++;
        if (c.usd === null) { if (d.model && !s.unpriced.includes(d.model)) s.unpriced.push(d.model); } else s.usd += c.usd;
        for (const k of Object.keys(c.tokens) as (keyof Tokens)[]) s.tokens[k] += c.tokens[k];
        if (d.model && !s.models.includes(d.model)) s.models.push(d.model);
        if (s.status !== "closed") s.status = "open";
        break;
      }
      case "tool.start": {
        const d = e.data as EventData["tool.start"];
        if (d.call_id) started.set(d.call_id, { name: d.name, target: d.target, args: d.args_summary });
        if (s.status !== "closed") s.status = "open";
        break;
      }
      case "tool.end": {
        const d = e.data as EventData["tool.end"];
        const t = tools.get(d.name) ?? { name: d.name, count: 0, fails: 0, totalMs: 0 };
        t.count++;
        if (!d.ok) t.fails++;
        t.totalMs += d.duration_ms ?? 0;
        tools.set(d.name, t);
        const st = d.call_id ? started.get(d.call_id) : undefined;
        const label = d.target ?? st?.target ?? st?.args ?? "";
        const bad = !d.ok || outputFailed(d);
        if (!d.ok) s.errors.push({ ts: e.ts, text: clip(`${d.name}${label ? ` ${label}` : ""}${d.error ? `: ${d.error}` : " failed"}`, 160), source: d.name });
        else if (bad) s.errors.push({ ts: e.ts, text: clip(`${d.name}${label ? ` ${label}` : ""}: ${d.output_summary!.split("\n").filter(Boolean).pop()}`, 160), source: d.name });
        if (/^(terminal|execute_code|shell|bash)$/.test(d.name) && TEST_RE.test(label)) s.tests.push({ label: clip(label, 60), ok: !bad });
        break;
      }
      case "file.write": {
        const d = e.data as EventData["file.write"];
        const f = files.get(d.path) ?? { path: d.path, op: d.op ?? "write", count: 0, added: 0, removed: 0 };
        f.count++;
        f.op = d.op === "delete" ? "delete" : f.count > 1 && f.op !== "delete" ? "edit" : d.op ?? f.op;
        f.added += d.added ?? 0;
        f.removed += d.removed ?? 0;
        files.set(d.path, f);
        break;
      }
      case "plan.update": s.plan = (e.data as EventData["plan.update"]).items.slice(); break;
      case "subagent.start": {
        const d = e.data as EventData["subagent.start"];
        subs.set(d.id, { id: d.id, name: d.name ?? "Subagent", status: "running", goal: d.goal });
        break;
      }
      case "subagent.stop": {
        const d = e.data as EventData["subagent.stop"];
        const x = subs.get(d.id) ?? { id: d.id, name: "Subagent", status: "running" };
        x.status = d.status && /fail|error|timeout/i.test(d.status) ? "failed" : "done";
        if (d.summary) x.summary = d.summary;
        subs.set(d.id, x);
        break;
      }
      case "approval.request": {
        const d = e.data as EventData["approval.request"];
        pendingApproval = { text: clip(d.description ?? d.command ?? d.pattern ?? "a command", 120) };
        s.approvals.push(pendingApproval);
        break;
      }
      case "approval.response": {
        const d = e.data as EventData["approval.response"];
        if (pendingApproval) { pendingApproval.choice = d.choice ?? "answered"; pendingApproval = null; }
        break;
      }
      case "message": {
        const d = e.data as EventData["message"];
        if (d.role === "user") { if (!s.userMessage) s.userMessage = clip(d.text.replace(/\s+/g, " "), 200); if (!titled && /^Hermes( · |\s*session$)/.test(s.title)) s.title = clip(d.text.replace(/\s+/g, " "), 60); }
        else s.finalMessage = clip(d.text, 600);
        break;
      }
      case "error": {
        const d = e.data as EventData["error"];
        s.errors.push({ ts: e.ts, text: clip(d.message, 160), source: d.kind ?? "error" });
        break;
      }
    }
  }
  s.durationMs = Math.max(0, s.endedAt - s.startedAt);
  s.tools = [...tools.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  s.files = [...files.values()];
  s.subagents = [...subs.values()];
  return s;
}

// ---------- cost dashboard ----------

export interface CostPoint { key: string; label: string; usd: number; tokens: number; calls: number; unpriced: number }

/** Local calendar day (YYYY-MM-DD) of an epoch-ms timestamp. offsetMin follows Date#getTimezoneOffset (UTC+7 → -420). */
export function dayKey(ts: number, offsetMin = new Date(ts).getTimezoneOffset()): string {
  return new Date(ts - offsetMin * 60_000).toISOString().slice(0, 10);
}
export const monthKey = (ts: number, offsetMin?: number) => dayKey(ts, offsetMin).slice(0, 7);

interface LlmRow { ts: number; session: string; model: string; usd: number | null; tokens: number }
function llmRows(events: readonly ExtEvent[], fallback: Price | null): LlmRow[] {
  const out: LlmRow[] = [];
  for (const e of attribute(events)) {
    if (e.type !== "llm.call") continue;
    const d = e.data as EventData["llm.call"];
    const c = llmCost(d, fallback);
    out.push({ ts: e.ts, session: e.session, model: d.model ?? "unknown model", usd: c.usd, tokens: c.tokens.total });
  }
  return out;
}

function add(m: Map<string, CostPoint>, key: string, label: string, r: LlmRow) {
  const p = m.get(key) ?? { key, label, usd: 0, tokens: 0, calls: 0, unpriced: 0 };
  p.usd += r.usd ?? 0;
  if (r.usd === null) p.unpriced++;
  p.tokens += r.tokens;
  p.calls++;
  m.set(key, p);
}

/** One point per calendar day for the `days` days ending on `now`'s day (zeros included). */
export function costByDay(events: readonly ExtEvent[], opts: { now?: number; days?: number; offsetMin?: number; fallback?: Price | null } = {}): CostPoint[] {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 14;
  const off = opts.offsetMin;
  const m = new Map<string, CostPoint>();
  for (const r of llmRows(events, opts.fallback ?? null)) add(m, dayKey(r.ts, off), "", r);
  const out: CostPoint[] = [];
  const today = Date.parse(`${dayKey(now, off)}T12:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    // step back on calendar keys (UTC noon), so DST shifts never skip or repeat a day
    const k = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    const p = m.get(k) ?? { key: k, label: "", usd: 0, tokens: 0, calls: 0, unpriced: 0 };
    p.label = new Date(`${k}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    out.push(p);
  }
  return out;
}

export function costByModel(events: readonly ExtEvent[], fallback: Price | null = null): CostPoint[] {
  const m = new Map<string, CostPoint>();
  for (const r of llmRows(events, fallback)) add(m, r.model, r.model, r);
  return [...m.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

export function costBySession(events: readonly ExtEvent[], titles: Record<string, string> = {}, fallback: Price | null = null): CostPoint[] {
  const m = new Map<string, CostPoint>();
  for (const r of llmRows(events, fallback)) add(m, r.session, titles[r.session] ?? r.session, r);
  return [...m.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

/** Spend today and this month (local calendar), for budgets. */
export function spendNow(events: readonly ExtEvent[], opts: { now?: number; offsetMin?: number; fallback?: Price | null } = {}): { day: number; month: number; dayKey: string; monthKey: string } {
  const now = opts.now ?? Date.now();
  const dk = dayKey(now, opts.offsetMin), mk = dk.slice(0, 7);
  let day = 0, month = 0;
  for (const r of llmRows(events, opts.fallback ?? null)) {
    const k = dayKey(r.ts, opts.offsetMin);
    if (k.slice(0, 7) === mk) month += r.usd ?? 0;
    if (k === dk) day += r.usd ?? 0;
  }
  return { day, month, dayKey: dk, monthKey: mk };
}

/** Titles per session (session.start title, else the first user message), for the dashboard. */
export function sessionTitles(events: readonly ExtEvent[]): Record<string, string> {
  const t: Record<string, string> = {};
  for (const e of attribute(events)) {
    if (e.type === "session.start") {
      const d = e.data as EventData["session.start"];
      if (d.title) t[e.session] = d.title;
      else t[e.session] ??= d.platform ? `Hermes · ${d.platform}` : "Hermes session";
    } else if (e.type === "message" && (e.data as EventData["message"]).role === "user" && (!t[e.session] || /^Hermes( · |\s*session$)/.test(t[e.session]))) {
      t[e.session] = clip((e.data as EventData["message"]).text.replace(/\s+/g, " "), 60);
    }
  }
  return t;
}
