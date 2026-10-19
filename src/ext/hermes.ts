// Hermes Agent (Nous Research) → Overtime events.
//
// Input is the envelope Hermes itself uses for shell hooks and outbound webhooks
// (agent/shell_hooks.py `_payload_fields`, agent/outbound_webhooks.py `_serialize_payload`):
//
//   { hook_event_name, profile, tool_name, tool_input, session_id, cwd, extra: {…kwargs},
//     delivery_id, timestamp }
//
// `tool_input` is the tool's args (dict) for pre/post_tool_call and null otherwise; every other
// hook kwarg lands in `extra`. The hermes-overtime plugin posts the same envelope shape (batched),
// so this one mapper serves both the zero-code webhook path and the plugin path.

import type { EventData, EventType, ExtEventIn, PlanItem } from "./schema";

export interface HermesEnvelope {
  hook_event_name: string;
  profile?: string;
  tool_name?: string | null;
  tool_input?: Record<string, unknown> | null;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown> | null;
  delivery_id?: string;
  timestamp?: string;
}

/**
 * metadata (default): tool names, paths, URL hosts, the first words of a shell command, token
 *   counts, durations, statuses. No prompts, file contents, command lines, or tool outputs.
 * args: + tool arguments and full commands (truncated), subagent goals, approval commands.
 * full: + user/assistant messages and tool output summaries (truncated).
 */
export type Privacy = "metadata" | "args" | "full";

/** The hooks Overtime listens to. Observer hooks only for the plugin; the webhook path may add pre_tool_call (webhooks are notify-only anyway). */
export const HERMES_OBSERVER_HOOKS = [
  "on_session_start", "on_session_end", "on_session_finalize", "on_session_reset", "agent_loop_stopped",
  "pre_api_request", "post_api_request", "api_request_error", "on_interim_message",
  "post_tool_call", "post_llm_call",
  "subagent_start", "subagent_stop",
  "pre_approval_request", "post_approval_response", "on_human_input_request", "on_human_input_resolved",
  "on_skill_lifecycle",
] as const;
export const HERMES_WEBHOOK_EVENTS = ["pre_tool_call", ...HERMES_OBSERVER_HOOKS.filter((h) => h !== "on_interim_message")] as const;

const WRITE_TOOLS = new Set(["write_file", "patch"]);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : undefined);

function hostPath(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === "/" ? "" : x.pathname}`.slice(0, 200);
  } catch {
    return clip(u.split(/[?#]/)[0], 200);
  }
}

const MULTI = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "bunx", "docker", "podman", "kubectl", "helm", "cargo", "go", "uv", "pip", "pip3", "poetry", "make", "just", "systemctl", "wrangler", "fly", "flyctl", "vercel", "netlify", "gh", "terraform", "deno", "dotnet", "mvn", "gradle", "rails", "composer", "supabase", "firebase", "heroku", "crontab", "ansible-playbook", "pytest", "ruff", "eslint", "tsc", "vitest", "jest"]);

/**
 * The first words of each part of a shell command, without env assignments, flags, paths or
 * arguments: "cd /srv/api && FOO=1 npm run test -- -x | tee log" → "cd && npm run test && tee".
 * Enough to tell tests from deploys, never the arguments themselves.
 */
export function commandHead(cmd: string, words = 3): string {
  const heads: string[] = [];
  for (const seg of cmd.split(/&&|\|\||;|\||\n/).slice(0, 4)) {
    const toks = seg.trim().split(/\s+/).filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    const out: string[] = [];
    const pre: string[] = [];
    for (const t of toks) {
      if (!out.length && ["sudo", "time", "nohup", "exec", "env", "command"].includes(t)) { if (t === "sudo") pre.push(t); continue; }
      const pyM = t === "-m" && out.length === 1 && /^python/.test(out[0]);
      if (/^[<>&]/.test(t) || (t.startsWith("-") && !pyM) || !/^[\w.+:@-]{1,40}$/.test(t)) break;
      // only subcommands survive, never free arguments: "git push", "npm run test", "docker compose up"
      if (out.length === 1 && !pyM && !MULTI.has(out[0].replace(/^.*\//, ""))) break;
      if (out.length === 2 && !["run", "compose", "exec", "x", "-m"].includes(out[1])) break;
      out.push(t);
      if (out.length >= words) break;
    }
    if (out.length && !(out.length === 1 && out[0] === "cd")) heads.push([...pre, ...out].join(" "));
  }
  return heads.join(" && ").slice(0, 80);
}

/** Paths a patch touches (V4A "*** Update File: x" / unified "+++ b/x"). */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.add(m[1].trim());
  for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (m[1].trim() !== "/dev/null") out.add(m[1].trim());
  return [...out].slice(0, 20);
}

export interface ToolView {
  /** the most telling short target: a path, a URL host, a command head, a search query (args+) */
  target?: string;
  /** human summary of the arguments at the chosen privacy level */
  summary?: string;
  /** paths written by this tool call */
  writes: { path: string; op: "write" | "edit" | "patch" | "delete" }[];
  /** for todo_list: the plan items */
  plan?: PlanItem[];
}

/** Summarise a Hermes tool call (name + args dict) without leaking more than the privacy level allows. */
export function viewTool(name: string, args: Record<string, unknown> | null | undefined, privacy: Privacy): ToolView {
  const a = args && typeof args === "object" ? args : {};
  const v: ToolView = { writes: [] };
  const path = str(a.path) ?? str(a.file_path) ?? str(a.filepath);
  if (path) v.target = clip(path, 200);
  if (typeof a.url === "string") v.target = hostPath(a.url);
  if (typeof a.command === "string") {
    v.target = commandHead(a.command);
    if (privacy !== "metadata") v.summary = clip(a.command, 300);
  }
  if (typeof a.query === "string") v.summary = privacy === "metadata" ? undefined : clip(a.query, 200);
  if (name === "write_file" && path) v.writes.push({ path, op: "write" });
  if (name === "patch") {
    if (path) v.writes.push({ path, op: str(a.mode) === "patch" ? "patch" : "edit" });
    if (typeof a.patch === "string") for (const p of patchPaths(a.patch)) if (p !== path) v.writes.push({ path: p, op: "patch" });
    if (!v.target && v.writes[0]) v.target = v.writes[0].path;
  }
  if ((name === "todo_list" || name === "todo") && Array.isArray(a.todos)) {
    const map: Record<string, PlanItem["status"]> = { pending: "todo", in_progress: "doing", completed: "done", cancelled: "cancelled" };
    v.plan = (a.todos as Record<string, unknown>[]).filter((t) => t && typeof t === "object").slice(0, 40).map((t) => ({
      ...(str(t.id) ? { id: str(t.id)!.slice(0, 64) } : {}),
      text: clip(str(t.content) ?? str(t.text) ?? "(item)", 200),
      status: map[str(t.status) ?? "pending"] ?? "todo",
    }));
    v.summary = `${v.plan.length} item${v.plan.length === 1 ? "" : "s"}`;
  }
  if (name === "delegate_task") {
    const n = Array.isArray(a.tasks) ? a.tasks.length : 1;
    v.summary = privacy === "metadata" ? `${n} subagent${n === 1 ? "" : "s"}` : clip(str(a.goal) ?? `${n} tasks`, 200);
  }
  if (!v.summary && privacy !== "metadata") {
    const keys = Object.keys(a).filter((k) => !["content", "old_string", "new_string", "patch"].includes(k));
    if (keys.length) v.summary = clip(keys.map((k) => `${k}=${typeof a[k] === "string" ? clip(a[k] as string, 60) : JSON.stringify(a[k])?.slice(0, 40)}`).join(" "), 300);
  }
  if (!v.summary && privacy === "metadata") {
    const keys = Object.keys(a);
    if (keys.length && !v.target) v.summary = `args: ${keys.slice(0, 6).join(", ")}`;
  }
  return v;
}

function ev<T extends EventType>(type: T, env: HermesEnvelope, data: EventData[T], extra: Partial<ExtEventIn> = {}): ExtEventIn {
  const session = str(env.session_id) ?? "default";
  return {
    v: 1,
    type,
    ...(env.timestamp ? { ts: env.timestamp } : {}),
    session: session.replace(/[^\w.:@/-]/g, "_").slice(0, 128),
    ...extra,
    data,
  } as ExtEventIn;
}

const safeId = (s: string | undefined) => (s ? s.replace(/[^\w.:@/-]/g, "_").slice(0, 128) : undefined);

/** Assistant tool calls from post_api_request: plugin sends extra.tool_calls; Hermes' sanitized response carries choices[0].message.tool_calls. */
function toolCallsFrom(x: Record<string, unknown>): { id?: string; name: string; args?: Record<string, unknown> }[] {
  const direct = x.tool_calls;
  const resp = x.response as Record<string, unknown> | undefined;
  const fromResp = (resp?.choices as Record<string, unknown>[] | undefined)?.[0]?.message as Record<string, unknown> | undefined;
  const fromMsg = x.assistant_message as Record<string, unknown> | undefined;
  const list = (Array.isArray(direct) ? direct : (fromResp?.tool_calls as unknown[]) ?? (fromMsg?.tool_calls as unknown[]) ?? []) as Record<string, unknown>[];
  return list.slice(0, 20).flatMap((tc) => {
    if (!tc || typeof tc !== "object") return [];
    const fn = (tc.function as Record<string, unknown>) ?? tc;
    const name = str(fn.name);
    if (!name) return [];
    let args: Record<string, unknown> | undefined;
    if (fn.arguments && typeof fn.arguments === "object") args = fn.arguments as Record<string, unknown>;
    else if (typeof fn.arguments === "string") try { const p = JSON.parse(fn.arguments); if (p && typeof p === "object") args = p; } catch { /* partial JSON: names only */ }
    else if (tc.args && typeof tc.args === "object") args = tc.args as Record<string, unknown>;
    return [{ id: str(tc.id), name, args }];
  });
}

/**
 * Maps one Hermes hook envelope to zero or more Overtime events. Unknown hooks map to nothing, so a
 * newer Hermes that fires more events never breaks the office.
 */
export function mapHermes(env: HermesEnvelope, privacy: Privacy = "metadata"): ExtEventIn[] {
  if (!env || typeof env !== "object" || typeof env.hook_event_name !== "string") return [];
  const x = (env.extra && typeof env.extra === "object" ? env.extra : {}) as Record<string, unknown>;
  const out: ExtEventIn[] = [];
  const toolName = str(env.tool_name) ?? str(x.tool_name);
  const args = (env.tool_input ?? (x.args as Record<string, unknown> | undefined) ?? null) as Record<string, unknown> | null;
  switch (env.hook_event_name) {
    case "on_session_start":
      out.push(ev("session.start", env, { model: str(x.model), platform: str(x.platform), profile: str(env.profile), ...(privacy !== "metadata" && env.cwd ? { cwd: env.cwd } : {}) }));
      break;
    case "on_session_end": {
      const failed = x.failed === true;
      const interrupted = x.interrupted === true;
      out.push(ev("session.end", env, { status: failed ? "failed" : interrupted ? "interrupted" : "completed", reason: str(x.turn_exit_reason) ?? str(x.reason) }));
      break;
    }
    case "on_session_finalize":
    case "on_session_reset":
      out.push(ev("session.end", env, { status: "completed", reason: str(x.reason) ?? env.hook_event_name.replace("on_session_", ""), final: true }));
      break;
    case "agent_loop_stopped":
      out.push(ev("session.end", env, { status: "interrupted", reason: str(x.reason) ?? "stopped" }));
      break;
    case "pre_api_request":
      out.push(ev("agent.thinking", env, { text: `Calling ${str(x.model) ?? "the model"}${num(x.api_call_count) ? ` (step ${num(x.api_call_count)})` : ""}` }));
      break;
    case "post_api_request": {
      const u = (x.usage ?? {}) as Record<string, unknown>;
      const dur = num(x.api_duration);
      out.push(ev("llm.call", env, {
        model: str(x.response_model) ?? str(x.model),
        provider: str(x.provider),
        input_tokens: num(u.input_tokens) ?? num(u.prompt_tokens),
        output_tokens: num(u.output_tokens) ?? num(u.completion_tokens),
        cache_read_tokens: num(u.cache_read_tokens),
        cache_write_tokens: num(u.cache_write_tokens),
        reasoning_tokens: num(u.reasoning_tokens),
        cost_usd: num(x.cost_usd),
        duration_ms: dur !== undefined ? Math.round(dur * 1000) : undefined,
        finish_reason: str(x.finish_reason),
        tool_calls: num(x.assistant_tool_call_count),
      }));
      for (const tc of toolCallsFrom(x)) {
        const view = viewTool(tc.name, tc.args, privacy);
        out.push(ev("tool.start", env, { name: tc.name, call_id: safeId(tc.id), target: view.target, args_summary: view.summary }));
      }
      break;
    }
    case "api_request_error": {
      const e = (x.error ?? {}) as Record<string, unknown>;
      out.push(ev("error", env, { message: clip(str(e.message) ?? str(x.reason) ?? `provider error ${str(x.status_code) ?? ""}`.trim(), 300), kind: str(e.type) ?? "api_request_error", retryable: typeof x.retryable === "boolean" ? x.retryable : undefined }));
      break;
    }
    case "on_interim_message":
      if (typeof x.text === "string" && x.text.trim()) out.push(ev("agent.thinking", env, { text: privacy === "full" ? clip(x.text, 400) : "Writing an update…" }));
      break;
    case "pre_tool_call": {
      if (!toolName) break;
      const view = viewTool(toolName, args, privacy);
      out.push(ev("tool.start", env, { name: toolName, call_id: safeId(str(x.tool_call_id)), target: view.target, args_summary: view.summary }));
      break;
    }
    case "post_tool_call": {
      if (!toolName) break;
      const view = viewTool(toolName, args, privacy);
      const status = str(x.status) ?? (x.error_message ? "error" : "ok");
      const ok = status === "ok";
      const result = typeof x.result === "string" ? x.result : x.result !== undefined && x.result !== null ? JSON.stringify(x.result) : "";
      out.push(ev("tool.end", env, {
        name: toolName,
        call_id: safeId(str(x.tool_call_id)),
        ok,
        status,
        duration_ms: num(x.duration_ms),
        target: view.target,
        error: ok ? undefined : clip(privacy === "metadata" ? str(x.error_type) ?? status : str(x.error_message) ?? str(x.error_type) ?? status, 300),
        output_summary: privacy === "full" && result ? clip(result, 300) : undefined,
      }));
      if (ok) for (const w of view.writes) out.push(ev("file.write", env, { path: w.path, op: w.op }));
      if (ok && view.plan) out.push(ev("plan.update", env, { items: view.plan }));
      if (ok) out.push(...skillMemoryEvents(toolName, args, env));
      break;
    }
    case "on_skill_lifecycle": {
      // newer Hermes: an authoritative skill-usage change (created, patched, edited, loaded, installed, archived, …)
      const name = str(x.skill_name);
      const action = str(x.action);
      if (!name || !action) break;
      out.push(ev("skill.update", env, { name: clip(name, 128), action: clip(action, 32), source: "lifecycle", use_count: num(x.use_count), provenance: str(x.provenance)?.slice(0, 32) }));
      break;
    }
    case "post_llm_call":
      if (privacy === "full") {
        if (typeof x.user_message === "string" && x.user_message) out.push(ev("message", env, { role: "user", text: clip(x.user_message, 1000) }));
        if (typeof x.assistant_response === "string" && x.assistant_response) out.push(ev("message", env, { role: "assistant", text: clip(x.assistant_response, 1000) }));
      } else out.push(ev("agent.thinking", env, { text: "Replied" }));
      break;
    case "subagent_start": {
      const id = safeId(str(x.child_session_id) ?? str(x.child_subagent_id));
      if (!id) break;
      const goal = str(x.child_goal);
      out.push(ev("subagent.start", { ...env, session_id: str(x.parent_session_id) ?? env.session_id }, {
        id,
        role: str(x.child_role),
        name: subagentName(goal, str(x.child_role), privacy),
        goal: privacy === "metadata" || !goal ? undefined : clip(goal, 300),
        child_session: safeId(str(x.child_session_id)),
      }));
      break;
    }
    case "subagent_stop": {
      const id = safeId(str(x.child_session_id) ?? str(x.child_subagent_id));
      if (!id) break;
      const hist = Array.isArray(x.tool_call_history) ? x.tool_call_history.length : undefined;
      out.push(ev("subagent.stop", { ...env, session_id: str(x.parent_session_id) ?? env.session_id }, {
        id,
        status: str(x.child_status),
        duration_ms: num(x.duration_ms),
        tools: hist,
        summary: privacy === "metadata" ? undefined : str(x.child_summary) ? clip(str(x.child_summary)!, 400) : undefined,
      }));
      break;
    }
    case "pre_approval_request":
      out.push(ev("approval.request", env, {
        id: safeId(str(x.tool_call_id)),
        command: privacy === "metadata" ? undefined : clip(str(x.command) ?? "", 300) || undefined,
        description: str(x.description) ? clip(str(x.description)!, 300) : undefined,
        surface: str(x.surface),
        pattern: str(x.pattern_key),
      }));
      break;
    case "post_approval_response":
      out.push(ev("approval.response", env, { id: safeId(str(x.tool_call_id)), choice: str(x.choice) }));
      break;
    case "on_human_input_request":
      out.push(ev("human_input.request", env, { id: safeId(str(x.request_id)), kind: str(x.kind), prompt: privacy === "metadata" ? undefined : str(x.prompt) ? clip(str(x.prompt)!, 300) : undefined }));
      break;
    case "on_human_input_resolved":
      out.push(ev("human_input.resolved", env, { id: safeId(str(x.request_id)), outcome: str(x.outcome) }));
      break;
    default:
      break;
  }
  // drop undefined keys so stored events stay tidy
  for (const e of out) e.data = Object.fromEntries(Object.entries(e.data as Record<string, unknown>).filter(([, v]) => v !== undefined)) as never;
  // per-delivery idempotency key: Hermes retries a failed delivery once with the same delivery_id
  if (env.delivery_id) out.forEach((e, i) => (e.id = safeId(`${env.delivery_id}:${i}`)));
  return out;
}

const SKILL_ACTIONS: Record<string, string> = { create: "created", edit: "edited", patch: "patched", delete: "deleted", write_file: "edited", remove_file: "edited" };

/**
 * Skills and memory from tool calls (Hermes 0.19 has no on_skill_lifecycle yet): skill_manage
 * create/patch/edit/delete, skill_view, the memory tool (add/replace/remove) and session_search.
 * Names and actions only: never a skill's body or what was remembered.
 */
export function skillMemoryEvents(tool: string, args: Record<string, unknown> | null, env: HermesEnvelope): ExtEventIn[] {
  const a = args ?? {};
  const name = str(a.name) ?? str(a.skill) ?? str(a.skill_name);
  if (tool === "skill_manage") {
    const action = SKILL_ACTIONS[str(a.action) ?? ""];
    return name && action ? [ev("skill.update", env, { name: clip(name, 128), action, source: "tool" })] : [];
  }
  if (tool === "skill_view") return name ? [ev("skill.update", env, { name: clip(name, 128), action: "viewed", source: "tool" })] : [];
  if (tool === "memory") {
    const action = str(a.action);
    if (action && !["add", "replace", "remove"].includes(action)) return [];
    return [ev("memory.write", env, { action: action ?? "add", target: str(a.target) === "user" ? "user" : "memory", source: "memory" })];
  }
  if (tool === "session_search") return [ev("memory.recall", env, { source: "session_search" })];
  return [];
}

/** A short name tag for a subagent: a few words of its goal (args+), else its role. */
export function subagentName(goal: string | undefined, role: string | undefined, privacy: Privacy): string {
  if (goal && privacy !== "metadata") {
    const words = goal.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().split(/\s+/).slice(0, 3).join(" ");
    if (words) return clip(words, 24);
  }
  return role && role !== "leaf" ? clip(role, 24) : "Subagent";
}
