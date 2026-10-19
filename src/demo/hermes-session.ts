// A recorded Hermes Agent session, in the exact envelope Hermes sends to outbound webhooks
// (hook_event_name, profile, tool_name, tool_input, session_id, cwd, extra, delivery_id, timestamp;
// see hermes-agent agent/outbound_webhooks.py). Replayed through the same mapper and office reducer
// as a live Hermes, fully offline.
//
// The session: a user asks Hermes (CLI, Claude Sonnet 4 via OpenRouter) to add a /health endpoint
// to a FastAPI service, test it and ship it. Hermes plans with `todo`, reads the code, delegates a
// docs check to a subagent, patches, runs pytest (one failure, then green), lints, pushes, and asks
// for approval before restarting the systemd service.

import type { HermesEnvelope } from "../ext/hermes";

export const HERMES_DEMO_TASK = "Add a /health endpoint to the FastAPI service, test it and ship it";
export const HERMES_DEMO_TITLE = "Hermes · /health endpoint for the API";

const SID = "20261019_201544_a3f9c1";
const CHILD = "20261019_201612_d41e07";
const CWD = "/srv/kedai-api";
const MODEL = "anthropic/claude-sonnet-4";

type Step = [delayMs: number, env: Omit<HermesEnvelope, "timestamp" | "delivery_id" | "profile" | "cwd">];

let turn = 0;
let api = 0;
const T = "turn_7f3a";

function apiCall(input: number, output: number, cacheRead: number, durS: number, toolCalls: { id: string; name: string; args: Record<string, unknown> }[], session = SID, task = "task_main"): Step[] {
  api++;
  const id = `req_${session.slice(-4)}_${api}`;
  return [
    [350, { hook_event_name: "pre_api_request", tool_name: null, tool_input: null, session_id: session, extra: { task_id: task, turn_id: T, api_request_id: id, platform: "cli", model: MODEL, provider: "openrouter", base_url: "https://openrouter.ai/api/v1", api_mode: "chat_completions", api_call_count: api, message_count: 4 + api * 2, tool_count: 31, approx_input_tokens: input + cacheRead, max_tokens: 8192, started_at: 0 } }],
    [Math.round(durS * 1000), { hook_event_name: "post_api_request", tool_name: null, tool_input: null, session_id: session, extra: {
      task_id: task, turn_id: T, api_request_id: id, platform: "cli", model: MODEL, provider: "openrouter", base_url: "https://openrouter.ai/api/v1", api_mode: "chat_completions",
      api_call_count: api, api_duration: durS, finish_reason: toolCalls.length ? "tool_calls" : "stop", message_count: 5 + api * 2, response_model: MODEL,
      usage: { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: 0, reasoning_tokens: 0, request_count: 1, prompt_tokens: input + cacheRead, total_tokens: input + cacheRead + output },
      assistant_content_chars: toolCalls.length ? 0 : 412, assistant_tool_call_count: toolCalls.length,
      response: { model: MODEL, choices: [{ finish_reason: toolCalls.length ? "tool_calls" : "stop", message: { role: "assistant", tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }] },
    } }],
  ];
}

function tool(id: string, name: string, args: Record<string, unknown>, runMs: number, result: string, status: "ok" | "error" = "ok", session = SID, task = "task_main"): Step[] {
  return [
    [180, { hook_event_name: "pre_tool_call", tool_name: name, tool_input: args, session_id: session, extra: { task_id: task, tool_call_id: id, turn_id: T, api_request_id: `req_${session.slice(-4)}_${api}` } }],
    [runMs, { hook_event_name: "post_tool_call", tool_name: name, tool_input: args, session_id: session, extra: { task_id: task, tool_call_id: id, turn_id: T, api_request_id: `req_${session.slice(-4)}_${api}`, result, duration_ms: runMs, status, error_type: status === "ok" ? null : "ToolError", error_message: status === "ok" ? null : result } }],
  ];
}

const todos = (s: [string, string][]) => s.map(([content, status], i) => ({ id: String(i + 1), content, status }));
const PLAN = ["Find the FastAPI app and its routers", "Check FastAPI docs for health-check conventions", "Add GET /health with a DB ping", "Write a test and run pytest + ruff", "Push the branch and restart the service"];
const plan = (states: string[]) => ({ todos: todos(PLAN.map((p, i) => [p, states[i]] as [string, string])), merge: false });

export function hermesDemoScript(): Step[] {
  turn = 0;
  api = 0;
  void turn;
  const s: Step[] = [];
  s.push([300, { hook_event_name: "on_session_start", tool_name: null, tool_input: null, session_id: SID, extra: { model: MODEL, platform: "cli" } }]);
  s.push(...apiCall(6120, 214, 0, 2.4, [{ id: "call_01", name: "todo", args: plan(["in_progress", "pending", "pending", "pending", "pending"]) }]));
  s.push(...tool("call_01", "todo", plan(["in_progress", "pending", "pending", "pending", "pending"]), 12, '{"todos": 5}'));
  s.push(...apiCall(410, 96, 6100, 1.9, [{ id: "call_02", name: "search_files", args: { pattern: "FastAPI\\(", path: "app", target: "content" } }, { id: "call_03", name: "read_file", args: { path: "app/main.py" } }]));
  s.push(...tool("call_02", "search_files", { pattern: "FastAPI\\(", path: "app", target: "content" }, 140, "app/main.py:7: app = FastAPI(title=\"Kedai API\")"));
  s.push(...tool("call_03", "read_file", { path: "app/main.py" }, 60, "     1|from fastapi import FastAPI\n     2|from app.db import engine\n…"));
  // delegate the docs check to a subagent (runs in its own session)
  s.push(...apiCall(690, 180, 6500, 2.2, [{ id: "call_04", name: "delegate_task", args: { goal: "Check FastAPI docs for health-check endpoint conventions", context: "FastAPI 0.115, SQLAlchemy engine in app/db.py" } }]));
  s.push([200, { hook_event_name: "pre_tool_call", tool_name: "delegate_task", tool_input: { goal: "Check FastAPI docs for health-check endpoint conventions", context: "FastAPI 0.115, SQLAlchemy engine in app/db.py" }, session_id: SID, extra: { task_id: "task_main", tool_call_id: "call_04", turn_id: T } }]);
  s.push([400, { hook_event_name: "subagent_start", tool_name: null, tool_input: null, session_id: SID, extra: { parent_session_id: SID, parent_turn_id: T, parent_subagent_id: null, child_session_id: CHILD, child_subagent_id: "sa_1", child_role: "leaf", child_goal: "Check FastAPI docs for health-check endpoint conventions" } }]);
  s.push(...apiCall(2900, 120, 0, 1.6, [{ id: "call_s1", name: "web_search", args: { query: "fastapi health check endpoint best practice" } }], CHILD, "task_sa_1"));
  s.push(...tool("call_s1", "web_search", { query: "fastapi health check endpoint best practice" }, 1300, '{"results": 6}', "ok", CHILD, "task_sa_1"));
  s.push(...apiCall(3400, 90, 2900, 1.4, [{ id: "call_s2", name: "web_extract", args: { urls: ["https://fastapi.tiangolo.com/advanced/events/"] } }], CHILD, "task_sa_1"));
  s.push(...tool("call_s2", "web_extract", { urls: ["https://fastapi.tiangolo.com/advanced/events/"] }, 1700, "Lifespan events…", "ok", CHILD, "task_sa_1"));
  s.push(...apiCall(5100, 260, 3300, 2.6, [], CHILD, "task_sa_1"));
  s.push([500, { hook_event_name: "subagent_stop", tool_name: null, tool_input: null, session_id: SID, extra: { parent_session_id: SID, parent_turn_id: T, child_session_id: CHILD, child_role: "leaf", child_summary: "Keep /health cheap: 200 + {status, db}; ping the DB with SELECT 1; no auth; exclude from OpenAPI.", child_status: "completed", tool_call_history: [{ tool: "web_search", arg_names: ["query"], outcome: "ok" }, { tool: "web_extract", arg_names: ["urls"], targets: ["fastapi.tiangolo.com/advanced/events/"], outcome: "ok" }], duration_ms: 11800 } }]);
  s.push([150, { hook_event_name: "post_tool_call", tool_name: "delegate_task", tool_input: { goal: "Check FastAPI docs for health-check endpoint conventions" }, session_id: SID, extra: { task_id: "task_main", tool_call_id: "call_04", turn_id: T, result: '{"status":"completed"}', duration_ms: 11900, status: "ok", error_type: null, error_message: null } }]);
  s.push(...apiCall(980, 160, 7100, 1.8, [{ id: "call_05", name: "todo", args: plan(["completed", "completed", "in_progress", "pending", "pending"]) }]));
  s.push(...tool("call_05", "todo", plan(["completed", "completed", "in_progress", "pending", "pending"]), 10, '{"todos": 5}'));
  const patch = "*** Begin Patch\n*** Update File: app/main.py\n@@\n from app.db import engine\n+from sqlalchemy import text\n@@\n+@app.get(\"/health\", include_in_schema=False)\n+def health():\n+    with engine.connect() as c:\n+        c.execute(text(\"SELECT 1\"))\n+    return {\"status\": \"ok\", \"db\": \"ok\"}\n*** End Patch";
  s.push(...apiCall(1200, 540, 7300, 3.9, [{ id: "call_06", name: "patch", args: { mode: "patch", patch } }, { id: "call_07", name: "write_file", args: { path: "tests/test_health.py", content: "from fastapi.testclient import TestClient\nfrom app.main import app\n\ndef test_health():\n    r = TestClient(app).get('/health')\n    assert r.status_code == 200\n    assert r.json()['status'] == 'ok'\n" } }]));
  s.push(...tool("call_06", "patch", { mode: "patch", patch }, 90, "Applied 1 hunk to app/main.py"));
  s.push(...tool("call_07", "write_file", { path: "tests/test_health.py", content: "…" }, 40, "Wrote 7 lines"));
  s.push(...apiCall(820, 70, 8200, 1.3, [{ id: "call_08", name: "terminal", args: { command: "cd /srv/kedai-api && python -m pytest -q tests/test_health.py" } }]));
  s.push(...tool("call_08", "terminal", { command: "cd /srv/kedai-api && python -m pytest -q tests/test_health.py" }, 2600, "F\nE   sqlalchemy.exc.OperationalError: no such table: products\n1 failed in 1.21s"));
  s.push(...apiCall(1500, 230, 8400, 2.7, [{ id: "call_09", name: "patch", args: { mode: "replace", path: "tests/test_health.py", old_string: "from app.main import app", new_string: "from app.main import app\nimport os\nos.environ.setdefault('DATABASE_URL', 'sqlite:///:memory:')" } }]));
  s.push(...tool("call_09", "patch", { mode: "replace", path: "tests/test_health.py", old_string: "…", new_string: "…" }, 50, "Replaced 1 occurrence"));
  s.push(...apiCall(700, 60, 9100, 1.1, [{ id: "call_10", name: "terminal", args: { command: "cd /srv/kedai-api && python -m pytest -q" } }, { id: "call_11", name: "terminal", args: { command: "ruff check app tests" } }]));
  s.push(...tool("call_10", "terminal", { command: "cd /srv/kedai-api && python -m pytest -q" }, 3100, "......\n6 passed in 2.04s"));
  s.push(...tool("call_11", "terminal", { command: "ruff check app tests" }, 700, "All checks passed!"));
  s.push(...apiCall(900, 150, 9300, 1.7, [{ id: "call_12", name: "todo", args: plan(["completed", "completed", "completed", "completed", "in_progress"]) }]));
  s.push(...tool("call_12", "todo", plan(["completed", "completed", "completed", "completed", "in_progress"]), 10, '{"todos": 5}'));
  s.push(...apiCall(760, 110, 9500, 1.5, [{ id: "call_13", name: "terminal", args: { command: "git checkout -b feat/health && git commit -am 'Add /health endpoint' && git push -u origin feat/health" } }]));
  s.push(...tool("call_13", "terminal", { command: "git checkout -b feat/health && git commit -am 'Add /health endpoint' && git push -u origin feat/health" }, 2300, "To github.com:kedai/kedai-api.git\n * [new branch]      feat/health -> feat/health"));
  // a dangerous command: Hermes asks the human in its own UI; Overtime only shows it
  s.push(...apiCall(640, 80, 9900, 1.2, [{ id: "call_14", name: "terminal", args: { command: "sudo systemctl restart kedai-api" } }]));
  s.push([200, { hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "sudo systemctl restart kedai-api" }, session_id: SID, extra: { task_id: "task_main", tool_call_id: "call_14", turn_id: T } }]);
  s.push([300, { hook_event_name: "pre_approval_request", tool_name: null, tool_input: null, session_id: SID, extra: { command: "sudo systemctl restart kedai-api", description: "Run a command with sudo (restarts a system service)", pattern_key: "sudo", pattern_keys: ["sudo", "systemctl"], session_key: SID, surface: "cli", turn_id: T, tool_call_id: "call_14" } }]);
  s.push([100, { hook_event_name: "on_human_input_request", tool_name: null, tool_input: null, session_id: SID, extra: { kind: "approval", request_id: "hin_31", session_key: SID, platform: "cli", prompt: "Allow: sudo systemctl restart kedai-api ? [once/session/always/deny]" } }]);
  s.push([5200, { hook_event_name: "post_approval_response", tool_name: null, tool_input: null, session_id: SID, extra: { command: "sudo systemctl restart kedai-api", description: "Run a command with sudo (restarts a system service)", pattern_key: "sudo", pattern_keys: ["sudo", "systemctl"], session_key: SID, surface: "cli", turn_id: T, tool_call_id: "call_14", choice: "once" } }]);
  s.push([80, { hook_event_name: "on_human_input_resolved", tool_name: null, tool_input: null, session_id: SID, extra: { kind: "approval", request_id: "hin_31", session_key: SID, platform: "cli", outcome: "answered" } }]);
  s.push([1400, { hook_event_name: "post_tool_call", tool_name: "terminal", tool_input: { command: "sudo systemctl restart kedai-api" }, session_id: SID, extra: { task_id: "task_main", tool_call_id: "call_14", turn_id: T, result: "", duration_ms: 1400, status: "ok", error_type: null, error_message: null } }]);
  s.push(...apiCall(520, 70, 10100, 1.0, [{ id: "call_15", name: "terminal", args: { command: "curl -fsS http://127.0.0.1:8000/health" } }]));
  s.push(...tool("call_15", "terminal", { command: "curl -fsS http://127.0.0.1:8000/health" }, 300, '{"status":"ok","db":"ok"}'));
  s.push(...apiCall(700, 120, 10300, 1.6, [{ id: "call_16", name: "todo", args: plan(["completed", "completed", "completed", "completed", "completed"]) }]));
  s.push(...tool("call_16", "todo", plan(["completed", "completed", "completed", "completed", "completed"]), 10, '{"todos": 5}'));
  // Hermes' learning loop: it remembers how this service is run and saves the workflow as a skill
  // (names only reach Overtime: the bookshelf gains a book, the filing cabinet glows)
  s.push(...apiCall(760, 260, 10400, 2.2, [{ id: "call_17", name: "memory", args: { action: "add", target: "memory", content: "kedai-api runs under systemd; restart needs sudo approval" } }, { id: "call_18", name: "skill_manage", args: { action: "create", name: "fastapi-health-endpoint", category: "devops", content: "…" } }]));
  s.push(...tool("call_17", "memory", { action: "add", target: "memory", content: "…" }, 30, '{"success": true}'));
  s.push(...tool("call_18", "skill_manage", { action: "create", name: "fastapi-health-endpoint", category: "devops", content: "…" }, 60, '{"success": true}'));
  s.push(...apiCall(820, 310, 10500, 3.1, []));
  s.push([300, { hook_event_name: "post_llm_call", tool_name: null, tool_input: null, session_id: SID, extra: { task_id: "task_main", turn_id: T, user_message: HERMES_DEMO_TASK, assistant_response: "Done. GET /health now returns {status, db} after a SELECT 1. Added tests/test_health.py (6 tests pass, ruff clean), pushed feat/health and restarted kedai-api; curl confirms it is up.", model: MODEL, platform: "cli" } }]);
  s.push([400, { hook_event_name: "on_session_end", tool_name: null, tool_input: null, session_id: SID, extra: { task_id: "task_main", turn_id: T, completed: true, failed: false, interrupted: false, turn_exit_reason: "final_response", model: MODEL, platform: "cli" } }]);
  return s;
}

/** Stamps the envelopes as Hermes would on delivery. */
export function stampEnvelope(env: Step[1], at: number, n: number): HermesEnvelope {
  return { ...env, profile: "default", cwd: CWD, delivery_id: `demo${String(n).padStart(4, "0")}`, timestamp: new Date(at).toISOString() };
}
