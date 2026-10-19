// Parses and validates the structured JSON tool call each agent turn must produce.
// Models wrap JSON in prose or code fences; we extract the first balanced object, then check it
// against a small per-tool schema. Anything that fails returns a precise error the agent can fix.

import type { Role, TaskMode, ToolCall, ToolName, ToolSpec } from "./types";

type FieldType = "string" | "array" | "object" | "boolean" | "number";
interface FieldSpec {
  type: FieldType;
  required?: boolean;
  max?: number;
  enum?: string[];
}

export const TOOL_SCHEMAS: Record<ToolName, Record<string, FieldSpec>> = {
  write_file: { path: { type: "string", required: true, max: 300 }, content: { type: "string", required: true, max: 200_000 }, ticket: { type: "string", max: 20 } },
  read_file: { path: { type: "string", required: true, max: 300 }, start_line: { type: "number" }, end_line: { type: "number" } },
  list_files: { prefix: { type: "string", max: 300 } },
  search_repo: { query: { type: "string", required: true, max: 200 }, regex: { type: "boolean" } },
  edit_file: { path: { type: "string", required: true, max: 300 }, edits: { type: "array", required: true }, ticket: { type: "string", max: 20 } },
  delete_file: { path: { type: "string", required: true, max: 300 }, reason: { type: "string", required: true, max: 300 } },
  run_checks: {},
  ask_user: { question: { type: "string", required: true, max: 500 } },
  handoff: {
    to: { type: "string", required: true, enum: ["pm", "research", "coder", "reviewer", "ops"] },
    summary: { type: "string", required: true, max: 400 },
    tickets: { type: "array" },
    brief: { type: "string", max: 20_000 },
    verdict: { type: "string", enum: ["pass", "fix"] },
    fixes: { type: "array" },
    plan: { type: "string", max: 6000 },
    files: { type: "array" },
  },
  finish: { summary: { type: "string", required: true, max: 600 }, title: { type: "string", max: 120 } },
};

/** Which tools each role may call. The orchestrator rejects anything else. */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  pm: ["ask_user", "handoff"],
  research: ["read_file", "write_file", "list_files", "handoff"],
  coder: ["list_files", "read_file", "write_file", "handoff"],
  reviewer: ["run_checks", "read_file", "list_files", "handoff"],
  ops: ["list_files", "finish"],
};

/** Repo mode: agents read the real repo and change it with patches; Ops opens the PR after approval. */
export const REPO_ROLE_TOOLS: Record<Role, ToolName[]> = {
  pm: ["list_files", "read_file", "search_repo", "ask_user", "handoff"],
  research: ["list_files", "read_file", "search_repo", "handoff"],
  coder: ["list_files", "read_file", "search_repo", "write_file", "edit_file", "delete_file", "handoff"],
  reviewer: ["run_checks", "read_file", "list_files", "handoff"],
  ops: ["list_files", "finish"],
};

export const toolsFor = (role: Role, mode: TaskMode = "site") => (mode === "repo" ? REPO_ROLE_TOOLS : ROLE_TOOLS)[role];

const TOOL_DESC: Record<ToolName, string> = {
  write_file: "Create or overwrite a whole file with full content.",
  read_file: "Read a file (optionally a line range).",
  list_files: "List files (optionally under a prefix).",
  run_checks: "Run the automated checks and get the report.",
  ask_user: "Ask the human one short question (the run pauses).",
  handoff: "Finish your part and pass the work to the next teammate.",
  finish: "Finish the run.",
  search_repo: "Search file paths and the contents of files read so far.",
  edit_file: "Patch a file with exact search/replace edits (each search must match exactly once).",
  delete_file: "Delete a file (needs the human's approval).",
};

/** OpenAI function-calling specs for a role's tools. `thought` rides along as an argument. */
export function toolSpecs(role: Role, mode: TaskMode = "site"): ToolSpec[] {
  return toolsFor(role, mode).map((name) => {
    const props: Record<string, unknown> = { thought: { type: "string", description: "one short sentence the human will see" } };
    const required: string[] = ["thought"];
    for (const [k, f] of Object.entries(TOOL_SCHEMAS[name])) {
      if (f.type === "array") props[k] = k === "edits"
        ? { type: "array", items: { type: "object", properties: { search: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, required: ["search", "replace"] } }
        : { type: "array", items: k === "tickets" ? { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, owner: { type: "string", enum: ["research", "coder", "reviewer", "ops"] } } } : { type: "string" } };
      else props[k] = { type: f.type === "number" ? "integer" : f.type, ...(f.enum ? { enum: f.enum } : {}) };
      if (f.required) required.push(k);
    }
    return { type: "function", function: { name, description: TOOL_DESC[name], parameters: { type: "object", properties: props, required } } };
  });
}

/**
 * Best-effort repair of almost-JSON from models without JSON mode: code fences, prose around the
 * object, smart quotes, raw newlines inside strings, trailing commas, missing closing brackets.
 */
export function repairJson(text: string): string | null {
  const attempts: string[] = [];
  let s = text.replace(/^\uFEFF/, "").trim();
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/);
  if (fenced) s = fenced[1];
  const start = s.indexOf("{");
  if (start < 0) return null;
  s = s.slice(start);
  attempts.push(fixStructure(s));
  attempts.push(fixStructure(s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")));
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return a;
    } catch { /* next */ }
  }
  return null;
}

function fixStructure(src: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; out += c; continue; }
      if (c === "\\") { esc = true; out += c; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") continue;
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      stack.pop();
      out += c;
      if (!stack.length) break; // first complete top-level value
      continue;
    }
    out += c;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Returns the first balanced top-level JSON object found in text, or null. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let s = start; s < text.length; s++) {
    if (text[s] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(s, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function typeOf(v: unknown): FieldType | "other" {
  if (typeof v === "string") return "string";
  if (typeof v === "number" && Number.isFinite(v)) return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "array";
  if (v && typeof v === "object") return "object";
  return "other";
}

export type ParseResult = { ok: true; call: ToolCall } | { ok: false; error: string };

export function parseToolCall(text: string, role: Role, mode: TaskMode = "site"): ParseResult {
  const allowed = toolsFor(role, mode);
  let raw = extractJsonObject(text);
  // a valid inner object (e.g. args) can hide a broken outer one: prefer a repaired whole reply that has "tool"
  if (!raw || !/"tool"\s*:/.test(raw)) raw = repairJson(text) ?? raw;
  if (!raw) return { ok: false, error: "No JSON object found. Reply with exactly one JSON object: {\"thought\": string, \"tool\": string, \"args\": object}." };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const tool = obj.tool;
  if (typeof tool !== "string" || !(tool in TOOL_SCHEMAS)) return { ok: false, error: `"tool" must be one of: ${allowed.join(", ")}.` };
  if (!allowed.includes(tool as ToolName)) return { ok: false, error: `Tool "${tool}" is not available to ${role}. Allowed: ${allowed.join(", ")}.` };
  const args = obj.args ?? {};
  if (typeOf(args) !== "object") return { ok: false, error: `"args" must be an object.` };
  const spec = TOOL_SCHEMAS[tool as ToolName];
  const a = args as Record<string, unknown>;
  for (const [key, f] of Object.entries(spec)) {
    const v = a[key];
    if (v === undefined || v === null) {
      if (f.required) return { ok: false, error: `${tool}: missing required arg "${key}".` };
      continue;
    }
    if (typeOf(v) !== f.type) return { ok: false, error: `${tool}: arg "${key}" must be ${f.type}.` };
    if (f.max && typeof v === "string" && v.length > f.max) return { ok: false, error: `${tool}: arg "${key}" is longer than ${f.max} characters.` };
    if (f.enum && typeof v === "string" && !f.enum.includes(v)) return { ok: false, error: `${tool}: arg "${key}" must be one of ${f.enum.join(", ")}.` };
  }
  const thought = typeof obj.thought === "string" ? obj.thought.slice(0, 600) : "";
  return { ok: true, call: { thought, tool: tool as ToolName, args: a } };
}

/** Normalises a workspace path and refuses anything that escapes the project root. */
export function safePath(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
  if (!s || s.length > 200) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "" || x === "." || /[\x00-\x1f:*?"<>|]/.test(x))) return null;
  if (!/\.(html|css|js|mjs|json|svg|txt|md|webmanifest|xml|ico)$/i.test(s)) return null;
  return s;
}
