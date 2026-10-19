// Stuck detection: cheap heuristics over one session's events that say "this agent is going in
// circles" before the bill or the clock says it. Pure, so the browser runs it today and a Worker
// (or the notification side) can run the very same code later. Signal: "session.stuck" (signals.ts).

import type { EventData, ExtEvent } from "../ext/schema";
import { llmCost, outputFailed } from "./aggregate";
import type { Price } from "../ext/pricing";

export interface StuckThresholds {
  enabled: boolean;
  /** the same tool with the same arguments this many times in a row */
  repeatTool: number;
  /** this many failures among the last `errorWindow` tool results / errors */
  repeatErrors: number;
  errorWindow: number;
  /** no events for this many minutes while a turn is running (not waiting for you) */
  idleMin: number;
  /** a model call that costs this many times the median of the session's earlier calls… */
  costSpikeX: number;
  /** …and at least this much */
  costSpikeMinUsd: number;
}

export const DEFAULT_STUCK: StuckThresholds = { enabled: true, repeatTool: 4, repeatErrors: 3, errorWindow: 6, idleMin: 10, costSpikeX: 5, costSpikeMinUsd: 0.05 };

export type StuckKind = "repeat-tool" | "repeat-error" | "idle" | "cost-spike";
export interface StuckReason {
  kind: StuckKind;
  text: string;
  /** seq of the first event of the evidence: a new streak gets a new key, so a dismissed banner can come back */
  since: number;
  /** the tool involved, when there is one (the office picks the desk from it) */
  tool?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Is a turn running: something happened after the last session.end, and nobody is being waited on? */
export function turnState(events: readonly ExtEvent[]): { open: boolean; waiting: boolean; lastTs: number } {
  let open = false, waiting = false, lastTs = 0;
  for (const e of events) {
    lastTs = Math.max(lastTs, e.ts);
    switch (e.type) {
      case "session.end": open = false; waiting = false; break;
      case "approval.request": open = true; waiting = true; break;
      case "human_input.request": if ((e.data as EventData["human_input.request"]).kind !== "approval") waiting = true; open = true; break;
      case "approval.response": case "human_input.resolved": waiting = false; open = true; break;
      default: open = true;
    }
  }
  return { open, waiting, lastTs };
}

interface Call { sig: string; name: string; label: string; seq: number }

/** Tool calls in order: tool.start, or tool.end when no start was seen for that call. */
function toolCalls(events: readonly ExtEvent[]): Call[] {
  const out: Call[] = [];
  const seen = new Set<string>();
  const openNoId: string[] = [];
  for (const e of events) {
    if (e.type === "tool.start") {
      const d = e.data as EventData["tool.start"];
      if (d.call_id) { if (seen.has(d.call_id)) continue; seen.add(d.call_id); } else openNoId.push(d.name);
      const label = d.args_summary ?? d.target ?? "";
      out.push({ sig: `${d.name}\u0000${label}`, name: d.name, label, seq: e.seq });
    } else if (e.type === "tool.end") {
      const d = e.data as EventData["tool.end"];
      if (d.call_id && seen.has(d.call_id)) continue;
      if (!d.call_id) { const i = openNoId.indexOf(d.name); if (i >= 0) { openNoId.splice(i, 1); continue; } }
      if (d.call_id) seen.add(d.call_id);
      const label = d.target ?? "";
      out.push({ sig: `${d.name}\u0000${label}`, name: d.name, label, seq: e.seq });
    }
  }
  return out;
}

/**
 * Returns why a session looks stuck at time `now` (empty when it does not). `events` are one
 * session's events in order (see sessionEvents). Only a running turn can be stuck: once the turn
 * ends, or while the agent waits for an approval or your answer, nothing fires.
 */
export function detectStuck(events: readonly ExtEvent[], now: number, th: StuckThresholds = DEFAULT_STUCK, fallback: Price | null = null): StuckReason[] {
  if (!th.enabled || !events.length) return [];
  const turn = turnState(events);
  if (!turn.open || turn.waiting) return [];
  const out: StuckReason[] = [];

  // 1. the same tool with the same arguments N times in a row
  const calls = toolCalls(events);
  if (calls.length && th.repeatTool >= 2) {
    const last = calls[calls.length - 1];
    let n = 0;
    for (let i = calls.length - 1; i >= 0 && calls[i].sig === last.sig; i--) n++;
    if (n >= th.repeatTool) out.push({ kind: "repeat-tool", text: `Called ${clip(`${last.name}${last.label ? ` ${last.label}` : ""}`, 70)} ${n} times in a row with the same arguments`, since: calls[calls.length - n].seq, tool: last.name });
  }

  // 2. repeated errors among the latest tool results
  if (th.repeatErrors >= 1) {
    const outcomes: { ok: boolean; seq: number; name?: string; text: string }[] = [];
    for (const e of events) {
      if (e.type === "tool.end") { const d = e.data as EventData["tool.end"]; const bad = !d.ok || outputFailed(d); outcomes.push({ ok: !bad, seq: e.seq, name: d.name, text: d.error ?? (d.ok && bad ? `${d.name}: ${d.output_summary!.split("\n").filter(Boolean).pop()}` : `${d.name} failed`) }); }
      else if (e.type === "error") outcomes.push({ ok: false, seq: e.seq, text: (e.data as EventData["error"]).message });
    }
    const win = outcomes.slice(-Math.max(th.errorWindow, th.repeatErrors));
    const fails = win.filter((o) => !o.ok);
    if (fails.length >= th.repeatErrors && !win[win.length - 1].ok) {
      out.push({ kind: "repeat-error", text: `${fails.length} of the last ${win.length} tool results failed (latest: ${clip(fails[fails.length - 1].text, 60)})`, since: fails[0].seq, tool: fails[fails.length - 1].name });
    }
  }

  // 3. silence while a turn is running
  if (th.idleMin > 0 && now - turn.lastTs >= th.idleMin * 60_000) {
    const mins = Math.floor((now - turn.lastTs) / 60_000);
    out.push({ kind: "idle", text: `No events for ${mins} min while a turn is running`, since: events[events.length - 1].seq });
  }

  // 4. a cost spike on the latest model call
  const costs: { usd: number; seq: number }[] = [];
  for (const e of events) if (e.type === "llm.call") { const c = llmCost(e.data as EventData["llm.call"], fallback); if (c.usd !== null) costs.push({ usd: c.usd, seq: e.seq }); }
  if (costs.length >= 4 && th.costSpikeX > 1) {
    const last = costs[costs.length - 1];
    const med = median(costs.slice(0, -1).map((c) => c.usd));
    if (last.usd >= th.costSpikeMinUsd && last.usd >= th.costSpikeX * Math.max(med, 1e-6)) {
      out.push({ kind: "cost-spike", text: `The latest model call cost $${last.usd.toFixed(3)}, ${med > 0 ? `${Math.round(last.usd / med)}×` : "far above"} the session's typical $${med.toFixed(4)}`, since: last.seq });
    }
  }
  return out;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Validates thresholds coming from storage or a form. */
export function normalizeThresholds(x: Partial<StuckThresholds> | null | undefined): StuckThresholds {
  const n = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const o = x ?? {};
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_STUCK.enabled,
    repeatTool: Math.round(n(o.repeatTool, DEFAULT_STUCK.repeatTool, 2, 50)),
    repeatErrors: Math.round(n(o.repeatErrors, DEFAULT_STUCK.repeatErrors, 1, 50)),
    errorWindow: Math.round(n(o.errorWindow, DEFAULT_STUCK.errorWindow, 1, 100)),
    idleMin: n(o.idleMin, DEFAULT_STUCK.idleMin, 0, 24 * 60),
    costSpikeX: n(o.costSpikeX, DEFAULT_STUCK.costSpikeX, 1.5, 1000),
    costSpikeMinUsd: n(o.costSpikeMinUsd, DEFAULT_STUCK.costSpikeMinUsd, 0, 1000),
  };
}
