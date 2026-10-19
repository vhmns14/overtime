// Which of the five office characters shows an external agent's activity.
// Rules are data (configurable in the UI, stored with the office settings); first match wins.

import type { Role } from "../engine/types";
import type { ExtEvent } from "./schema";

export interface RoleRule {
  role: Role;
  /** event types this rule applies to, e.g. ["tool.start","tool.end"]; omitted = any */
  types?: string[];
  /** regex on the tool name */
  tool?: string;
  /** regex on the tool target (path / URL host / command head) */
  target?: string;
  /** short reason shown in the docs and the settings UI */
  note?: string;
}

const TOOL_EVENTS = ["tool.start", "tool.end"];

export const DEFAULT_RULES: RoleRule[] = [
  { role: "pm", types: ["agent.thinking", "llm.call", "message", "plan.update", "session.start"], note: "planning and model thinking" },
  { role: "pm", types: TOOL_EVENTS, tool: "^(todo_list|todo|clarify|memory|skill_view|skills_list|skill_manage|session_search|delegate_task|kanban_.*)$", note: "plans, memory, skills, delegation" },
  { role: "ops", types: TOOL_EVENTS, tool: "^(cronjob.*|cronjob_manage|process_manage)$", note: "cron and long-running processes" },
  { role: "ops", types: TOOL_EVENTS, tool: "^(terminal|execute_code)$", target: "\\b(git push|git tag|docker|podman|kubectl|helm|wrangler|fly|flyctl|vercel|netlify|systemctl|crontab|terraform|ansible-playbook|heroku|supabase|firebase|scp|rsync|ssh|npm publish|deploy)\\b", note: "deploys, pushes, containers, services" },
  { role: "reviewer", types: TOOL_EVENTS, tool: "^(terminal|execute_code)$", target: "\\b(test|tests|pytest|vitest|jest|mocha|unittest|tox|nox|lint|eslint|ruff|flake8|pylint|mypy|pyright|tsc|check|verify|cargo test|go test|go vet|playwright)\\b", note: "tests, lint, type checks" },
  { role: "reviewer", types: TOOL_EVENTS, tool: "^(lsp_.*|diagnostics|vision_analyze)$", note: "diagnostics and visual checks" },
  { role: "research", types: TOOL_EVENTS, tool: "^(web_search|web_extract|x_search|browser_.*|read_file|search_files|read_.*|feishu_doc_read|mcp_.*search.*)$", note: "web, browser, reading and searching" },
  { role: "coder", types: TOOL_EVENTS, tool: "^(write_file|patch|terminal|execute_code|image_generate|text_to_speech)$", note: "writing files and running commands" },
  { role: "coder", types: ["file.write"], note: "file writes" },
  { role: "reviewer", types: ["error"], note: "errors get a second pair of eyes" },
];

/** null = no rule matched (callers fall back to the character that was last active). */
export function roleFor(e: Pick<ExtEvent, "type" | "data">, rules: RoleRule[] = DEFAULT_RULES): Role | null {
  const d = e.data as Record<string, unknown>;
  const name = typeof d.name === "string" ? d.name : "";
  const target = typeof d.target === "string" ? d.target : typeof d.path === "string" ? d.path : "";
  for (const r of rules) {
    if (r.types && !r.types.includes(e.type)) continue;
    try {
      if (r.tool !== undefined && !new RegExp(r.tool, "i").test(name)) continue;
      if (r.target !== undefined && !new RegExp(r.target, "i").test(target)) continue;
    } catch {
      continue; // a broken user regex never breaks the office
    }
    return r.role;
  }
  return TOOL_EVENTS.includes(e.type) ? "coder" : null;
}

const ROLE_SET = new Set(["pm", "research", "coder", "reviewer", "ops"]);

/** Parses user-edited rules (JSON); returns null with a message when invalid. */
export function parseRules(text: string): { rules: RoleRule[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(v) || !v.length) return { error: "Expected a non-empty JSON array of rules." };
  const out: RoleRule[] = [];
  for (const [i, r] of v.entries()) {
    if (!r || typeof r !== "object") return { error: `Rule ${i + 1} is not an object.` };
    const o = r as Record<string, unknown>;
    if (typeof o.role !== "string" || !ROLE_SET.has(o.role)) return { error: `Rule ${i + 1}: role must be one of pm, research, coder, reviewer, ops.` };
    for (const k of ["tool", "target"] as const) {
      if (o[k] === undefined) continue;
      if (typeof o[k] !== "string") return { error: `Rule ${i + 1}: ${k} must be a regex string.` };
      try { new RegExp(o[k] as string); } catch { return { error: `Rule ${i + 1}: ${k} is not a valid regex.` }; }
    }
    if (o.types !== undefined && (!Array.isArray(o.types) || o.types.some((t) => typeof t !== "string"))) return { error: `Rule ${i + 1}: types must be an array of event types.` };
    out.push({ role: o.role as Role, ...(o.types ? { types: o.types as string[] } : {}), ...(o.tool !== undefined ? { tool: o.tool as string } : {}), ...(o.target !== undefined ? { target: o.target as string } : {}), ...(typeof o.note === "string" ? { note: o.note } : {}) });
  }
  return { rules: out };
}
