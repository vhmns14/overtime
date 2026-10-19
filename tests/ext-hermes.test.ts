import { describe, expect, it } from "vitest";
import { mapHermes, viewTool, commandHead, patchPaths, subagentName, type HermesEnvelope } from "../src/ext/hermes";
import { validateEvent } from "../src/ext/schema";

const env = (hook: string, extra: Record<string, unknown> = {}, tool?: string, input?: Record<string, unknown>): HermesEnvelope => ({
  hook_event_name: hook, profile: "default", tool_name: tool ?? null, tool_input: input ?? null, session_id: "20261019_090826_7eba2a", cwd: "/srv/app", extra, delivery_id: "abc123", timestamp: "2026-10-19T09:08:26Z",
});

describe("Hermes envelope → Overtime events", () => {
  it("session lifecycle", () => {
    expect(mapHermes(env("on_session_start", { model: "openai/gpt-4o-mini", platform: "cli" }))).toMatchObject([{ type: "session.start", session: "20261019_090826_7eba2a", data: { model: "openai/gpt-4o-mini", platform: "cli", profile: "default" } }]);
    expect(mapHermes(env("on_session_end", { completed: true, interrupted: false, failed: false, turn_exit_reason: "final_response" }))[0]).toMatchObject({ type: "session.end", data: { status: "completed", reason: "final_response" } });
    expect(mapHermes(env("on_session_end", { interrupted: true }))[0].data).toMatchObject({ status: "interrupted" });
    expect(mapHermes(env("on_session_end", { failed: true }))[0].data).toMatchObject({ status: "failed" });
    expect(mapHermes(env("on_session_finalize", { reason: "shutdown" }))[0].data).toMatchObject({ final: true });
    expect(mapHermes(env("agent_loop_stopped", { reason: "/stop" }))[0].data).toMatchObject({ status: "interrupted" });
  });

  it("post_api_request → llm.call with Hermes' canonical usage buckets, plus tool.start per assistant tool call", () => {
    const out = mapHermes(env("post_api_request", {
      model: "openai/gpt-4o-mini", response_model: "openai/gpt-4o-mini-2024-07-18", provider: "openrouter", api_duration: 1.25, finish_reason: "tool_calls", assistant_tool_call_count: 2, cost_usd: 0.0012,
      usage: { input_tokens: 253, output_tokens: 110, cache_read_tokens: 4480, cache_write_tokens: 0, reasoning_tokens: 0, prompt_tokens: 4733, total_tokens: 4843 },
      tool_calls: [{ id: "call_1", function: { name: "write_file", arguments: { path: "hello.py" } } }, { id: "call_2", function: { name: "terminal", arguments: { command: "python3 hello.py" } } }],
    }), "args");
    expect(out[0]).toMatchObject({ type: "llm.call", data: { model: "openai/gpt-4o-mini-2024-07-18", input_tokens: 253, output_tokens: 110, cache_read_tokens: 4480, duration_ms: 1250, cost_usd: 0.0012, tool_calls: 2 } });
    expect(out.slice(1)).toMatchObject([{ type: "tool.start", data: { name: "write_file", call_id: "call_1", target: "hello.py" } }, { type: "tool.start", data: { name: "terminal", target: "python3", args_summary: "python3 hello.py" } }]);
  });

  it("reads tool calls from Hermes' sanitized response payload too (outbound webhooks)", () => {
    const out = mapHermes(env("post_api_request", { usage: {}, response: { choices: [{ message: { tool_calls: [{ id: "c9", type: "function", function: { name: "web_search", arguments: "{\"query\":\"fastapi\"}" } }] } }] } }), "metadata");
    expect(out[1]).toMatchObject({ type: "tool.start", data: { name: "web_search", call_id: "c9" } });
    expect((out[1].data as Record<string, unknown>).args_summary).toBe("args: query"); // argument names, never the query itself
  });

  it("pre/post_tool_call with status, duration, writes and plans", () => {
    expect(mapHermes(env("pre_tool_call", { tool_call_id: "c1" }, "terminal", { command: "cd /srv && npm run test -- --watch=false" }))[0]).toMatchObject({ type: "tool.start", data: { name: "terminal", call_id: "c1", target: "npm run test" } });
    const w = mapHermes(env("post_tool_call", { tool_call_id: "c2", status: "ok", duration_ms: 108, result: "{\"bytes\":24}" }, "write_file", { path: "src/app.py", content: "print(1)" }));
    expect(w).toMatchObject([{ type: "tool.end", data: { name: "write_file", ok: true, duration_ms: 108, target: "src/app.py" } }, { type: "file.write", data: { path: "src/app.py", op: "write" } }]);
    const err = mapHermes(env("post_tool_call", { status: "error", error_type: "ToolError", error_message: "permission denied: /etc/x" }, "terminal", { command: "cat /etc/x" }));
    expect(err[0].data).toMatchObject({ ok: false, error: "ToolError" });
    expect(mapHermes(env("post_tool_call", { status: "error", error_message: "permission denied" }, "terminal", {}), "args")[0].data).toMatchObject({ error: "permission denied" });
    const plan = mapHermes(env("post_tool_call", { status: "ok" }, "todo", { todos: [{ id: "1", content: "Read code", status: "completed" }, { id: "2", content: "Patch", status: "in_progress" }, { id: "3", content: "Drop", status: "cancelled" }] }));
    expect(plan[1]).toMatchObject({ type: "plan.update", data: { items: [{ id: "1", text: "Read code", status: "done" }, { id: "2", text: "Patch", status: "doing" }, { id: "3", status: "cancelled" }] } });
    expect(mapHermes(env("post_tool_call", { status: "blocked" }, "write_file", { path: "x" })).map((e) => e.type)).toEqual(["tool.end"]); // no write when blocked
  });

  it("subagents are keyed by their child session (subagent_stop has no child_subagent_id)", () => {
    const s = mapHermes(env("subagent_start", { parent_session_id: "P", child_session_id: "C1", child_subagent_id: "sa_1", child_role: "leaf", child_goal: "Check FastAPI docs for health checks" }), "args");
    expect(s[0]).toMatchObject({ type: "subagent.start", session: "P", data: { id: "C1", child_session: "C1", name: "Check FastAPI docs", goal: "Check FastAPI docs for health checks" } });
    expect(mapHermes(env("subagent_start", { parent_session_id: "P", child_session_id: "C1", child_role: "leaf", child_goal: "secret plan" }))[0].data).toMatchObject({ id: "C1", name: "Subagent" });
    const stop = mapHermes(env("subagent_stop", { parent_session_id: "P", child_session_id: "C1", child_status: "completed", child_summary: "done", duration_ms: 1200, tool_call_history: [{}, {}] }));
    expect(stop[0]).toMatchObject({ type: "subagent.stop", session: "P", data: { id: "C1", status: "completed", duration_ms: 1200, tools: 2 } });
    expect((stop[0].data as Record<string, unknown>).summary).toBeUndefined();
  });

  it("approvals and human input are observed, commands only above metadata", () => {
    const a = mapHermes(env("pre_approval_request", { command: "sudo rm -rf /var/cache", description: "recursive delete", pattern_key: "rm_rf", surface: "cli", tool_call_id: "c7" }));
    expect(a[0]).toMatchObject({ type: "approval.request", data: { id: "c7", description: "recursive delete", pattern: "rm_rf", surface: "cli" } });
    expect((a[0].data as Record<string, unknown>).command).toBeUndefined();
    expect(mapHermes(env("pre_approval_request", { command: "sudo rm -rf /var/cache" }), "args")[0].data).toMatchObject({ command: "sudo rm -rf /var/cache" });
    expect(mapHermes(env("post_approval_response", { choice: "once" }))[0]).toMatchObject({ type: "approval.response", data: { choice: "once" } });
    expect(mapHermes(env("on_human_input_request", { kind: "clarify", request_id: "r1", prompt: "Which db?" }))[0]).toMatchObject({ type: "human_input.request", data: { kind: "clarify", id: "r1" } });
    expect(mapHermes(env("on_human_input_resolved", { kind: "clarify", request_id: "r1", outcome: "answered" }))[0]).toMatchObject({ type: "human_input.resolved", data: { outcome: "answered" } });
  });

  it("messages only at the full privacy level", () => {
    const e = env("post_llm_call", { user_message: "add a health check", assistant_response: "Done." });
    expect(mapHermes(e, "metadata").map((x) => x.type)).toEqual(["agent.thinking"]);
    expect(mapHermes(e, "full")).toMatchObject([{ type: "message", data: { role: "user", text: "add a health check" } }, { type: "message", data: { role: "assistant", text: "Done." } }]);
  });

  it("unknown hooks and junk map to nothing; delivery ids become idempotency keys", () => {
    expect(mapHermes(env("kanban_task_claimed", {}))).toEqual([]);
    expect(mapHermes({} as HermesEnvelope)).toEqual([]);
    const out = mapHermes(env("post_tool_call", { status: "ok" }, "write_file", { path: "a" }));
    expect(out.map((e) => e.id)).toEqual(["abc123:0", "abc123:1"]);
  });

  it("everything it emits passes the schema", () => {
    const hooks: HermesEnvelope[] = [
      env("on_session_start", { model: "m" }), env("pre_api_request", { model: "m", api_call_count: 3 }), env("post_api_request", { usage: { input_tokens: 1 } }),
      env("api_request_error", { error: { type: "RateLimit", message: "429" }, retryable: true }), env("on_interim_message", { text: "working" }),
      env("pre_tool_call", {}, "browser_navigate", { url: "https://example.com/a?token=x" }), env("post_tool_call", { status: "ok" }, "patch", { mode: "patch", patch: "*** Begin Patch\n*** Update File: a.py\n*** Add File: b.py\n*** End Patch" }),
      env("subagent_start", { child_session_id: "c" }), env("subagent_stop", { child_session_id: "c" }), env("pre_approval_request", {}), env("post_approval_response", { choice: "deny" }),
    ];
    for (const h of hooks) for (const e of mapHermes(h, "full")) expect(validateEvent(e).ok, `${h.hook_event_name} → ${e.type}`).toBe(true);
  });
});

describe("privacy-aware tool views", () => {
  it("command heads keep subcommands, never free arguments", () => {
    expect(commandHead("cd /srv/api && FOO=1 npm run test -- -x | tee log")).toBe("npm run test && tee");
    expect(commandHead("echo hunter2")).toBe("echo");
    expect(commandHead("git push origin main")).toBe("git push");
    expect(commandHead("python -m pytest -q")).toBe("python -m pytest");
    expect(commandHead("sudo systemctl restart api")).toBe("sudo systemctl restart");
    expect(commandHead("curl -fsS https://x.y/z?k=1")).toBe("curl");
    expect(commandHead("docker compose up -d --build")).toBe("docker compose up");
  });

  it("URLs lose their query strings, patches reveal only paths", () => {
    expect(viewTool("web_extract", { url: "https://docs.example.com/a/b?key=secret#x" }, "metadata").target).toBe("docs.example.com/a/b");
    expect(patchPaths("*** Begin Patch\n*** Update File: app/main.py\n+secret\n*** Delete File: old.py\n*** End Patch")).toEqual(["app/main.py", "old.py"]);
    const v = viewTool("patch", { mode: "patch", patch: "*** Update File: app/main.py\n+x" }, "metadata");
    expect(v.writes).toEqual([{ path: "app/main.py", op: "patch" }]);
    expect(v.summary).toBeUndefined();
  });

  it("subagent names use the goal only above metadata", () => {
    expect(subagentName("Check FastAPI docs for health", "leaf", "args")).toBe("Check FastAPI docs");
    expect(subagentName("Check FastAPI docs for health", "leaf", "metadata")).toBe("Subagent");
    expect(subagentName(undefined, "orchestrator", "metadata")).toBe("orchestrator");
  });
});
