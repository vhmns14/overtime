// The timeline: one row per event with a category, a one-line title and redacted details, plus
// filtering by category and free-text search. Pure.

import type { EventData, ExtEvent } from "../ext/schema";
import { redactString } from "../ext/redact";
import { llmCost, outputFailed } from "./aggregate";

export const FILTERS = ["tools", "errors", "llm", "files", "subagents", "approvals"] as const;
export type Filter = (typeof FILTERS)[number];
export type Category = Filter | "session" | "messages" | "plan";

export interface TimelineItem {
  /** index in the session's event list (what the replay seeks to) */
  i: number;
  seq: number;
  ts: number;
  type: string;
  cats: Category[];
  title: string;
  level: "info" | "warn" | "error";
  agent: string;
  /** redacted key/value pairs for the details view */
  detail: [string, string][];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ms = (v?: number) => (v === undefined ? "" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function details(d: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null || v === "") continue;
    let s: string;
    if (Array.isArray(v)) s = v.map((x) => (x && typeof x === "object" ? `${(x as { status?: string }).status === "done" ? "✓" : "·"} ${(x as { text?: string }).text ?? JSON.stringify(x)}` : String(x))).join("\n");
    else if (typeof v === "object") s = JSON.stringify(v);
    else s = String(v);
    out.push([k, clip(redactString(s), 600)]);
  }
  return out;
}

export function toItem(e: ExtEvent, i: number): TimelineItem {
  const d = e.data as Record<string, unknown>;
  let cats: Category[] = [];
  let title: string = e.type;
  let level: TimelineItem["level"] = "info";
  switch (e.type) {
    case "session.start": { const x = d as EventData["session.start"]; cats = ["session"]; title = `Session started${x.model ? ` · ${x.model}` : ""}${x.platform ? ` · ${x.platform}` : ""}`; break; }
    case "session.end": { const x = d as EventData["session.end"]; cats = ["session"]; title = x.final ? "Session closed" : x.status === "failed" ? "Turn failed" : x.status === "interrupted" ? "Turn interrupted" : "Turn finished"; if (x.status === "failed") level = "error"; break; }
    case "agent.thinking": { const x = d as EventData["agent.thinking"]; cats = ["llm"]; title = x.text ? `Thinking: ${clip(x.text, 80)}` : "Thinking…"; break; }
    case "llm.call": {
      const x = d as EventData["llm.call"];
      const c = llmCost(x);
      cats = ["llm"];
      title = `Model call${x.model ? ` · ${x.model}` : ""} · ${tok(c.tokens.input + c.tokens.cacheRead + c.tokens.cacheWrite)} in / ${tok(c.tokens.output)} out${c.usd ? ` · $${c.usd.toFixed(4)}` : ""}`;
      break;
    }
    case "tool.start": { const x = d as EventData["tool.start"]; cats = ["tools"]; title = `→ ${x.name}${x.target ? ` ${x.target}` : x.args_summary ? ` ${x.args_summary}` : ""}`; break; }
    case "tool.end": {
      const x = d as EventData["tool.end"];
      const bad = !x.ok || outputFailed(x);
      cats = bad ? ["tools", "errors"] : ["tools"];
      title = `${bad ? "✗" : "✓"} ${x.name}${x.target ? ` ${x.target}` : ""}${x.duration_ms !== undefined ? ` · ${ms(x.duration_ms)}` : ""}${!x.ok && x.error ? ` · ${x.error}` : x.ok && bad ? ` · ${x.output_summary!.split("\n").filter(Boolean).pop()}` : ""}`;
      if (bad) level = "warn";
      break;
    }
    case "file.write": { const x = d as EventData["file.write"]; cats = ["files"]; title = `${x.op === "delete" ? "Deleted" : x.op && x.op !== "write" ? "Edited" : "Wrote"} ${x.path}${x.added || x.removed ? ` (+${x.added ?? 0} −${x.removed ?? 0})` : ""}`; break; }
    case "plan.update": { const x = d as EventData["plan.update"]; cats = ["plan"]; title = `Plan: ${x.items.filter((t) => t.status === "done").length}/${x.items.length} done`; break; }
    case "subagent.start": { const x = d as EventData["subagent.start"]; cats = ["subagents"]; title = `Subagent “${x.name ?? "Subagent"}” started${x.goal ? `: ${clip(x.goal, 70)}` : ""}`; break; }
    case "subagent.stop": { const x = d as EventData["subagent.stop"]; cats = ["subagents"]; title = `Subagent ${x.status && /fail|error|timeout/i.test(x.status) ? "failed" : "finished"}${x.summary ? `: ${clip(x.summary, 70)}` : ""}`; if (x.status && /fail|error|timeout/i.test(x.status)) level = "warn"; break; }
    case "approval.request": { const x = d as EventData["approval.request"]; cats = ["approvals"]; title = `Asked for approval: ${x.description ?? x.command ?? x.pattern ?? "a command"}`; level = "warn"; break; }
    case "approval.response": { const x = d as EventData["approval.response"]; cats = ["approvals"]; title = `Approval: ${x.choice ?? "answered"}`; break; }
    case "human_input.request": { const x = d as EventData["human_input.request"]; cats = ["approvals"]; title = x.kind === "clarify" ? "Asked you a question" : x.kind === "sudo" ? "Asked for your sudo password" : x.kind === "approval" ? "Waiting for your approval" : "Waiting for your input"; level = "warn"; break; }
    case "human_input.resolved": { const x = d as EventData["human_input.resolved"]; cats = ["approvals"]; title = `Input ${x.outcome ?? "received"}`; break; }
    case "message": { const x = d as EventData["message"]; cats = ["messages"]; title = `${x.role === "user" ? "You" : "Hermes"}: ${clip(x.text.replace(/\s+/g, " "), 90)}`; break; }
    case "error": { const x = d as EventData["error"]; cats = ["errors"]; title = `Error: ${x.message}`; level = "error"; break; }
  }
  return { i, seq: e.seq, ts: e.ts, type: e.type, cats, title: clip(redactString(title), 160), level, agent: e.agent, detail: details(d) };
}

/** One row per event; a tool call announced twice (model reply + pre-tool hook) shows once. */
export function toTimeline(events: readonly ExtEvent[]): TimelineItem[] {
  const seen = new Set<string>();
  const out: TimelineItem[] = [];
  events.forEach((e, i) => {
    if (e.type === "tool.start") {
      const id = (e.data as EventData["tool.start"]).call_id;
      if (id) { if (seen.has(id)) return; seen.add(id); }
    }
    out.push(toItem(e, i));
  });
  return out;
}

/** No filters selected = everything. Search matches the title, the type, the agent and the details. */
export function filterTimeline(items: readonly TimelineItem[], filters: ReadonlySet<Filter>, query = ""): TimelineItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (filters.size && !it.cats.some((c) => filters.has(c as Filter))) return false;
    if (!q) return true;
    if (it.title.toLowerCase().includes(q) || it.type.includes(q) || it.agent.toLowerCase().includes(q)) return true;
    return it.detail.some(([k, v]) => k.includes(q) || v.toLowerCase().includes(q));
  });
}

export function countByFilter(items: readonly TimelineItem[]): Record<Filter, number> {
  const c = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
  for (const it of items) for (const k of it.cats) if (k in c) c[k as Filter]++;
  return c;
}
