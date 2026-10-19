// Parses and validates the structured JSON tool call each agent turn must produce.
// Models wrap JSON in prose or code fences; we extract the first balanced object, then check it
// against a small per-tool schema. Anything that fails returns a precise error the agent can fix.

import type { Role, ToolCall, ToolName } from "./types";

type FieldType = "string" | "array" | "object" | "boolean";
interface FieldSpec {
  type: FieldType;
  required?: boolean;
  max?: number;
  enum?: string[];
}

export const TOOL_SCHEMAS: Record<ToolName, Record<string, FieldSpec>> = {
  write_file: { path: { type: "string", required: true, max: 200 }, content: { type: "string", required: true, max: 200_000 }, ticket: { type: "string", max: 20 } },
  read_file: { path: { type: "string", required: true, max: 200 } },
  list_files: {},
  run_checks: {},
  ask_user: { question: { type: "string", required: true, max: 500 } },
  handoff: {
    to: { type: "string", required: true, enum: ["pm", "research", "coder", "reviewer", "ops"] },
    summary: { type: "string", required: true, max: 400 },
    tickets: { type: "array" },
    brief: { type: "string", max: 20_000 },
    verdict: { type: "string", enum: ["pass", "fix"] },
    fixes: { type: "array" },
  },
  finish: { summary: { type: "string", required: true, max: 600 } },
};

/** Which tools each role may call. The orchestrator rejects anything else. */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  pm: ["ask_user", "handoff"],
  research: ["read_file", "write_file", "list_files", "handoff"],
  coder: ["list_files", "read_file", "write_file", "handoff"],
  reviewer: ["run_checks", "read_file", "list_files", "handoff"],
  ops: ["list_files", "finish"],
};

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
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "array";
  if (v && typeof v === "object") return "object";
  return "other";
}

export type ParseResult = { ok: true; call: ToolCall } | { ok: false; error: string };

export function parseToolCall(text: string, role: Role): ParseResult {
  const raw = extractJsonObject(text);
  if (!raw) return { ok: false, error: "No JSON object found. Reply with exactly one JSON object: {\"thought\": string, \"tool\": string, \"args\": object}." };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const tool = obj.tool;
  if (typeof tool !== "string" || !(tool in TOOL_SCHEMAS)) return { ok: false, error: `"tool" must be one of: ${ROLE_TOOLS[role].join(", ")}.` };
  if (!ROLE_TOOLS[role].includes(tool as ToolName)) return { ok: false, error: `Tool "${tool}" is not available to ${role}. Allowed: ${ROLE_TOOLS[role].join(", ")}.` };
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
