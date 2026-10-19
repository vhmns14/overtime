// Overtime external-agent event schema, version 1 ("overtime.events.v1").
// Pure TypeScript, shared by the Worker (validation at ingest) and the UI (rendering).
// Documented in docs/EVENTS.md; the JSON Schema twin is docs/events.schema.json.

import { redactDeep } from "./redact";

export const SCHEMA_VERSION = 1;
export const SCHEMA_ID = "overtime.events.v1";

export const EVENT_TYPES = [
  "session.start",
  "session.end",
  "agent.thinking",
  "llm.call",
  "tool.start",
  "tool.end",
  "file.write",
  "plan.update",
  "subagent.start",
  "subagent.stop",
  "approval.request",
  "approval.response",
  "human_input.request",
  "human_input.resolved",
  "message",
  "error",
  // office: Hermes' skills and memory (names and counts only, never contents)
  "skill.update",
  "memory.write",
  "memory.recall",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface PlanItem { id?: string; text: string; status: "todo" | "doing" | "done" | "cancelled" }

/** data payload per event type (all fields optional unless marked) */
export interface EventData {
  "session.start": { title?: string; model?: string; platform?: string; profile?: string; cwd?: string };
  "session.end": { status?: "completed" | "interrupted" | "failed"; reason?: string; final?: boolean };
  "agent.thinking": { text?: string };
  "llm.call": { model?: string; provider?: string; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number; cost_usd?: number; duration_ms?: number; finish_reason?: string; tool_calls?: number };
  "tool.start": { name: string; call_id?: string; args_summary?: string; target?: string };
  "tool.end": { name: string; call_id?: string; ok: boolean; status?: string; duration_ms?: number; error?: string; output_summary?: string; target?: string };
  "file.write": { path: string; op?: "write" | "edit" | "patch" | "delete"; added?: number; removed?: number };
  "plan.update": { items: PlanItem[] };
  "subagent.start": { id: string; name?: string; role?: string; goal?: string; child_session?: string };
  "subagent.stop": { id: string; status?: string; summary?: string; duration_ms?: number; tools?: number };
  "approval.request": { id?: string; command?: string; description?: string; surface?: string; pattern?: string };
  "approval.response": { id?: string; choice?: string };
  "human_input.request": { id?: string; kind?: string; prompt?: string };
  "human_input.resolved": { id?: string; outcome?: string };
  message: { role: "user" | "assistant"; text: string };
  error: { message: string; kind?: string; retryable?: boolean };
  /** a skill was created, improved (patched/edited), loaded, viewed, installed, archived, restored or deleted */
  "skill.update": { name: string; action: string; source?: string; use_count?: number; provenance?: string };
  /** the agent wrote to its memory (add/replace/remove); target is "memory" or "user". Never the content */
  "memory.write": { action?: string; target?: string; source?: string };
  /** the agent recalled memory (e.g. Hermes' session_search) */
  "memory.recall": { source?: string; count?: number };
}

/** An event as sent by an agent (or produced by an adapter such as the Hermes mapper). */
export interface ExtEventIn<T extends EventType = EventType> {
  v?: number;
  type: T;
  /** epoch ms, or an ISO-8601 string; defaults to the time the server received it */
  ts?: number | string;
  /** the agent's conversation/session id; groups events into sessions inside one office */
  session?: string;
  /** "main" (default) or a subagent id from subagent.start */
  agent?: string;
  /** optional idempotency key; duplicates within an office are dropped */
  id?: string;
  data: EventData[T];
}

/** An event after validation, redaction and sequencing (what is stored and streamed). */
export interface ExtEvent<T extends EventType = EventType> {
  v: 1;
  seq: number;
  type: T;
  ts: number;
  session: string;
  agent: string;
  id?: string;
  data: EventData[T];
}

export const LIMITS = {
  bodyBytes: 256 * 1024,
  batch: 200,
  eventBytes: 16 * 1024,
  str: 2000,
  text: 4000,
  idLen: 128,
  planItems: 40,
};

type FieldSpec = { t: "string" | "number" | "boolean" | "enum" | "items"; req?: boolean; max?: number; values?: readonly string[] };
const S = (req = false, max = LIMITS.str): FieldSpec => ({ t: "string", req, max });
const N = (req = false): FieldSpec => ({ t: "number", req });
const B = (req = false): FieldSpec => ({ t: "boolean", req });
const E = (values: readonly string[], req = false): FieldSpec => ({ t: "enum", values, req });

export const DATA_SPEC: Record<EventType, Record<string, FieldSpec>> = {
  "session.start": { title: S(), model: S(false, 200), platform: S(false, 64), profile: S(false, 64), cwd: S(false, 400) },
  "session.end": { status: E(["completed", "interrupted", "failed"]), reason: S(false, 400), final: B() },
  "agent.thinking": { text: S(false, LIMITS.text) },
  "llm.call": { model: S(false, 200), provider: S(false, 64), input_tokens: N(), output_tokens: N(), cache_read_tokens: N(), cache_write_tokens: N(), reasoning_tokens: N(), cost_usd: N(), duration_ms: N(), finish_reason: S(false, 64), tool_calls: N() },
  "tool.start": { name: S(true, 128), call_id: S(false, LIMITS.idLen), args_summary: S(false, 600), target: S(false, 400) },
  "tool.end": { name: S(true, 128), call_id: S(false, LIMITS.idLen), ok: B(true), status: S(false, 32), duration_ms: N(), error: S(false, 600), output_summary: S(false, 600), target: S(false, 400) },
  "file.write": { path: S(true, 400), op: E(["write", "edit", "patch", "delete"]), added: N(), removed: N() },
  "plan.update": { items: { t: "items", req: true } },
  "subagent.start": { id: S(true, LIMITS.idLen), name: S(false, 80), role: S(false, 80), goal: S(false, 600), child_session: S(false, LIMITS.idLen) },
  "subagent.stop": { id: S(true, LIMITS.idLen), status: S(false, 32), summary: S(false, 1200), duration_ms: N(), tools: N() },
  "approval.request": { id: S(false, LIMITS.idLen), command: S(false, 600), description: S(false, 600), surface: S(false, 64), pattern: S(false, 128) },
  "approval.response": { id: S(false, LIMITS.idLen), choice: S(false, 32) },
  "human_input.request": { id: S(false, LIMITS.idLen), kind: S(false, 32), prompt: S(false, 600) },
  "human_input.resolved": { id: S(false, LIMITS.idLen), outcome: S(false, 32) },
  message: { role: E(["user", "assistant"], true), text: S(true, LIMITS.text) },
  error: { message: S(true, 600), kind: S(false, 64), retryable: B() },
  "skill.update": { name: S(true, 128), action: S(true, 32), source: S(false, 32), use_count: N(), provenance: S(false, 32) },
  "memory.write": { action: S(false, 32), target: S(false, 32), source: S(false, 32) },
  "memory.recall": { source: S(false, 64), count: N() },
};

export type ValidationResult = { ok: true; event: Omit<ExtEvent, "seq"> } | { ok: false; error: string };

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const ID_RE = /^[\w.:@/-]{1,128}$/;

function toTs(ts: unknown, now: number): number | null {
  if (ts === undefined || ts === null) return now;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const ms = ts < 1e11 ? ts * 1000 : ts; // accept epoch seconds too
    return ms > 0 ? Math.round(ms) : null;
  }
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Validates one incoming event, clips long strings, redacts anything that looks like a secret and
 * returns the normalized event (without seq). Unknown fields inside data are dropped: what is stored
 * is exactly what the schema describes.
 */
export function validateEvent(raw: unknown, now = Date.now()): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "event must be an object" };
  const e = raw as Record<string, unknown>;
  if (e.v !== undefined && e.v !== SCHEMA_VERSION) return { ok: false, error: `unsupported schema version ${String(e.v)}` };
  const type = e.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, error: `unknown event type ${JSON.stringify(String(type)).slice(0, 60)}` };
  const spec = DATA_SPEC[type as EventType];
  const ts = toTs(e.ts, now);
  if (ts === null) return { ok: false, error: "ts must be epoch ms/seconds or an ISO-8601 string" };
  for (const k of ["session", "agent", "id"] as const) {
    if (e[k] !== undefined && (typeof e[k] !== "string" || !ID_RE.test(e[k] as string))) return { ok: false, error: `${k} must match ${ID_RE.source}` };
  }
  const dataIn = e.data ?? {};
  if (typeof dataIn !== "object" || Array.isArray(dataIn)) return { ok: false, error: "data must be an object" };
  const d = dataIn as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(spec)) {
    const v = d[k];
    if (v === undefined || v === null) {
      if (f.req) return { ok: false, error: `${type}: data.${k} is required` };
      continue;
    }
    switch (f.t) {
      case "string":
        if (typeof v !== "string") return { ok: false, error: `${type}: data.${k} must be a string` };
        out[k] = clip(v, f.max ?? LIMITS.str);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, error: `${type}: data.${k} must be a non-negative number` };
        out[k] = v;
        break;
      case "boolean":
        if (typeof v !== "boolean") return { ok: false, error: `${type}: data.${k} must be a boolean` };
        out[k] = v;
        break;
      case "enum":
        if (typeof v !== "string" || !f.values!.includes(v)) return { ok: false, error: `${type}: data.${k} must be one of ${f.values!.join(", ")}` };
        out[k] = v;
        break;
      case "items": {
        if (!Array.isArray(v)) return { ok: false, error: `${type}: data.${k} must be an array` };
        const items: PlanItem[] = [];
        for (const it of v.slice(0, LIMITS.planItems)) {
          if (!it || typeof it !== "object") return { ok: false, error: `${type}: each item must be an object` };
          const o = it as Record<string, unknown>;
          if (typeof o.text !== "string" || !o.text.trim()) return { ok: false, error: `${type}: item.text is required` };
          const st = typeof o.status === "string" && ["todo", "doing", "done", "cancelled"].includes(o.status) ? (o.status as PlanItem["status"]) : "todo";
          items.push({ ...(typeof o.id === "string" ? { id: clip(o.id, 64) } : {}), text: clip(o.text, 200), status: st });
        }
        out[k] = items;
        break;
      }
    }
  }
  const event: Omit<ExtEvent, "seq"> = {
    v: 1,
    type: type as EventType,
    ts,
    session: (e.session as string | undefined) ?? "default",
    agent: (e.agent as string | undefined) ?? "main",
    ...(e.id ? { id: e.id as string } : {}),
    data: redactDeep(out) as EventData[EventType],
  };
  if (JSON.stringify(event).length > LIMITS.eventBytes) return { ok: false, error: "event too large" };
  return { ok: true, event };
}

/** Accepts a single event, an array, or {events:[…]}. */
export function unpackBatch(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.events)) return b.events;
    if (typeof b.type === "string") return [b];
  }
  return null;
}
