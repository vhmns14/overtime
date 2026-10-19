import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyEvent, newOffice, replay, latestSession, type Effect } from "../src/ext/office-state";
import { roleFor, parseRules, DEFAULT_RULES } from "../src/ext/roles";
import { mapHermes } from "../src/ext/hermes";
import { validateEvent, type ExtEvent, type ExtEventIn } from "../src/ext/schema";
import { hermesDemoScript, stampEnvelope } from "../src/demo/hermes-session";

let seq = 0;
const T0 = 1_790_000_000_000;
function ev(e: ExtEventIn, ts = T0 + seq * 1000): ExtEvent {
  const v = validateEvent({ ...e, ts }, ts);
  if (!v.ok) throw new Error(v.error);
  return { ...v.event, seq: ++seq } as ExtEvent;
}
const tool = (name: string, target?: string, extra: Partial<ExtEventIn> = {}) => ev({ type: "tool.start", session: "s1", data: { name, ...(target ? { target } : {}) }, ...extra } as ExtEventIn);

describe("role mapping defaults", () => {
  const r = (type: string, data: Record<string, unknown>) => roleFor({ type, data } as never);
  it("planning and thinking → PM, web/browser/read → Research, writes/terminal → Coder, tests → Reviewer, deploys/cron → Ops", () => {
    expect(r("llm.call", {})).toBe("pm");
    expect(r("agent.thinking", {})).toBe("pm");
    expect(r("tool.start", { name: "todo" })).toBe("pm");
    expect(r("tool.start", { name: "delegate_task" })).toBe("pm");
    expect(r("tool.start", { name: "web_search" })).toBe("research");
    expect(r("tool.start", { name: "browser_navigate" })).toBe("research");
    expect(r("tool.start", { name: "read_file" })).toBe("research");
    expect(r("tool.start", { name: "write_file" })).toBe("coder");
    expect(r("tool.start", { name: "patch" })).toBe("coder");
    expect(r("tool.start", { name: "terminal", target: "ls" })).toBe("coder");
    expect(r("tool.start", { name: "terminal", target: "python -m pytest" })).toBe("reviewer");
    expect(r("tool.start", { name: "terminal", target: "npm run lint" })).toBe("reviewer");
    expect(r("tool.start", { name: "terminal", target: "git push" })).toBe("ops");
    expect(r("tool.start", { name: "terminal", target: "docker compose up" })).toBe("ops");
    expect(r("tool.start", { name: "cronjob_manage" })).toBe("ops");
    expect(r("tool.start", { name: "some_mcp_tool" })).toBe("coder");
    expect(r("session.end", {})).toBeNull();
  });

  it("custom rules are validated and win in order", () => {
    expect(parseRules("nope")).toMatchObject({ error: expect.stringContaining("JSON") });
    expect(parseRules('[{"role":"boss"}]')).toMatchObject({ error: expect.stringContaining("role") });
    expect(parseRules('[{"role":"ops","tool":"("}]')).toMatchObject({ error: expect.stringContaining("regex") });
    const ok = parseRules('[{"role":"ops","types":["tool.start"],"tool":"^read_file$"}]');
    expect("rules" in ok && roleFor({ type: "tool.start", data: { name: "read_file" } } as never, ok.rules)).toBe("ops");
    expect(roleFor({ type: "tool.start", data: { name: "x" } } as never, [{ role: "pm", tool: "(" }, ...DEFAULT_RULES])).toBe("coder"); // broken regex is skipped
  });
});

describe("office reducer", () => {
  it("walks to the desk and types on tool.start, stops on tool.end, logs with durations", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "session.start", session: "s1", data: { model: "m" } }));
    const a = applyEvent(st, tool("web_search", undefined, { data: { name: "web_search", call_id: "c1" } } as never));
    expect(a.effects).toContainEqual(expect.objectContaining({ k: "work", role: "research", on: true }));
    const b = applyEvent(st, ev({ type: "tool.end", session: "s1", data: { name: "web_search", call_id: "c1", ok: true, duration_ms: 1300 } }));
    expect(b.effects).toContainEqual({ k: "work", role: "research", on: false });
    const s = st.sessions.s1;
    expect(s.log.at(-1)!.text).toBe("✓ web_search · 1.3 s");
    expect(s.steps.research.state).toBe("active");
  });

  it("dedupes a tool announced by both post_api_request and pre_tool_call", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "tool.start", session: "s1", data: { name: "terminal", call_id: "c1" } }));
    const again = applyEvent(st, ev({ type: "tool.start", session: "s1", data: { name: "terminal", call_id: "c1" } }));
    expect(again.effects).toEqual([]);
  });

  it("hands off at the table when the work moves to another desk (throttled)", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "session.start", session: "s1", data: {} }));
    applyEvent(st, tool("web_search"), );
    const h = applyEvent(st, ev({ type: "tool.start", session: "s1", data: { name: "write_file", target: "a.py" } }, T0 + 60_000));
    expect(h.effects).toContainEqual(expect.objectContaining({ k: "handoff", from: "research", to: "coder" }));
    const h2 = applyEvent(st, ev({ type: "tool.start", session: "s1", data: { name: "terminal", target: "pytest" } }, T0 + 61_000));
    expect(h2.effects.some((f) => f.k === "handoff")).toBe(false); // < 12 s since the last handoff
  });

  it("puts plans on the whiteboard and updates stickies in place", () => {
    const st = newOffice();
    const items = [{ text: "Read the code", status: "doing" }, { text: "Write a test", status: "todo" }];
    const a = applyEvent(st, ev({ type: "plan.update", session: "s1", data: { items } } as ExtEventIn));
    expect(a.effects[0]).toMatchObject({ k: "whiteboard", tickets: [{ title: "Read the code", status: "doing", owner: "research" }, { title: "Write a test", owner: "reviewer" }] });
    const b = applyEvent(st, ev({ type: "plan.update", session: "s1", data: { items: [{ text: "Read the code", status: "done" }, { text: "Write a test", status: "doing" }] } } as ExtEventIn));
    expect(b.effects[0].k).toBe("tickets");
    expect(st.sessions.s1.steps.plan.note).toBe("1/2");
  });

  it("lends a free desk to each subagent, attributes its own session there, and gives it back", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "session.start", session: "P", data: {} }));
    const s1 = applyEvent(st, ev({ type: "subagent.start", session: "P", data: { id: "C1", name: "Docs scout", child_session: "C1" } }));
    expect(s1.effects).toContainEqual({ k: "tag", role: "research", text: "Docs scout" });
    const s2 = applyEvent(st, ev({ type: "subagent.start", session: "P", data: { id: "C2", name: "Test writer", child_session: "C2" } }));
    expect(s2.effects).toContainEqual({ k: "tag", role: "coder", text: "Test writer" });
    // the child's own events (its own session id) land on its desk, in the parent session
    const w = applyEvent(st, ev({ type: "tool.start", session: "C2", data: { name: "web_search" } }));
    expect(w.session).toBe("P");
    expect(w.effects).toContainEqual(expect.objectContaining({ k: "work", role: "coder", on: true }));
    expect(st.sessions.P.log.at(-1)).toMatchObject({ agent: "coder", name: "Test writer" });
    // a child session's own lifecycle never becomes an office session
    expect(applyEvent(st, ev({ type: "session.start", session: "C2", data: {} })).effects).toEqual([]);
    expect(st.order).toEqual(["P"]);
    // main-agent work for a lent desk shows at the PM's desk
    expect(applyEvent(st, ev({ type: "tool.start", session: "P", data: { name: "read_file" } })).effects).toContainEqual(expect.objectContaining({ k: "work", role: "pm" }));
    const stop = applyEvent(st, ev({ type: "subagent.stop", session: "P", data: { id: "C1", status: "completed", summary: "Use SELECT 1" } }));
    expect(stop.effects).toContainEqual(expect.objectContaining({ k: "handoff", from: "research", to: "pm" }));
    expect(stop.effects).toContainEqual({ k: "tag", role: "research", text: null });
  });

  it("approval: the character waits with a read-only card until Hermes reports the answer", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "tool.start", session: "s1", data: { name: "terminal", call_id: "c1", target: "sudo systemctl restart" } }));
    const a = applyEvent(st, ev({ type: "approval.request", session: "s1", data: { description: "sudo", command: "sudo systemctl restart api" } }));
    expect(a.effects).toContainEqual({ k: "wait", role: "ops", text: "Waiting for approval in Hermes" }); // systemctl is Ops work
    expect(st.sessions.s1.pending).toMatchObject({ kind: "approval", detail: "sudo systemctl restart api" });
    expect(st.sessions.s1.status).toBe("waiting");
    const b = applyEvent(st, ev({ type: "approval.response", session: "s1", data: { choice: "once" } }));
    expect(b.effects).toContainEqual({ k: "clear-wait" });
    expect(st.sessions.s1.pending).toBeNull();
  });

  it("cost meter: cost_usd when sent, list price otherwise, tokens only for unknown models", () => {
    const st = newOffice();
    applyEvent(st, ev({ type: "llm.call", session: "s1", data: { model: "x/unknown", input_tokens: 1000, output_tokens: 10, cost_usd: 0.5 } }));
    applyEvent(st, ev({ type: "llm.call", session: "s1", data: { model: "openai/gpt-4o-mini", input_tokens: 1_000_000, output_tokens: 0 } }));
    applyEvent(st, ev({ type: "llm.call", session: "s1", data: { model: "mystery/model", input_tokens: 10, output_tokens: 10 } }));
    const c = st.sessions.s1.cost;
    expect(c.usd).toBeCloseTo(0.65, 6);
    expect(c.tokens).toBe(1_000_000 + 1010 + 20);
    expect(c.calls).toBe(3);
    expect(c.unpriced).toEqual(["mystery/model"]);
    expect(c.byAgent.pm.usd).toBeCloseTo(0.65, 6);
  });

  it("persistent office: new sessions are tracked separately and the latest one is followed", () => {
    const st = newOffice();
    const e1 = applyEvent(st, ev({ type: "session.start", session: "a", data: {} }, T0));
    expect(e1.effects).toContainEqual({ k: "session", id: "a" });
    applyEvent(st, ev({ type: "session.end", session: "a", data: { status: "completed" } }, T0 + 1000));
    applyEvent(st, ev({ type: "session.start", session: "b", data: { platform: "telegram" } }, T0 + 5000));
    expect(st.order).toEqual(["a", "b"]);
    expect(latestSession(st)).toBe("b");
    expect(st.sessions.a.status).toBe("idle");
    expect(st.sessions.b.title).toBe("Hermes · telegram");
  });

  it("replays the real Hermes 0.19 run captured by the plugin", () => {
    const events = JSON.parse(readFileSync("tests/fixtures/hermes-0.19-real-run.json", "utf8")) as ExtEvent[];
    const st = replay(events);
    const s = st.sessions[st.order[0]];
    expect(st.order).toHaveLength(1);
    expect(s.model).toBe("openai/gpt-4o-mini");
    expect(s.status).toBe("ended");
    expect(s.cost.calls).toBe(5);
    expect(s.cost.usd).toBeGreaterThan(0.001);
    expect(s.files).toEqual(["/home/user/demo/hello.py"]);
    expect(s.steps.plan.state).toBe("done");
    expect(s.steps.review.state).toBe("done"); // python -m pytest went to the Reviewer
    expect(s.log.filter((l) => l.text.startsWith("✓")).length).toBe(6);
  });

  it("the recorded demo replays end to end through mapper + schema + reducer", () => {
    const script = hermesDemoScript();
    const st = newOffice();
    const effects: Effect[] = [];
    let clock = T0, n = 0, sq = 0;
    for (const [delay, env] of script) {
      clock += delay;
      for (const raw of mapHermes(stampEnvelope(env, clock, n++), "full")) {
        const v = validateEvent(raw, clock);
        expect(v.ok).toBe(true);
        if (v.ok) effects.push(...applyEvent(st, { ...v.event, seq: ++sq } as ExtEvent).effects);
      }
    }
    expect(st.order).toHaveLength(1); // the subagent's own session folded into the parent
    const s = st.sessions[st.order[0]];
    expect(s.title).toMatch(/health endpoint/i);
    expect(Object.values(s.subagents)).toMatchObject([{ name: "Check FastAPI docs", status: "done", desk: "research" }]);
    expect(s.tickets.every((t) => t.status === "done")).toBe(true);
    expect(s.files.sort()).toEqual(["app/main.py", "tests/test_health.py"]);
    expect(s.pending).toBeNull();
    for (const step of ["plan", "research", "code", "review", "deploy"] as const) expect(s.steps[step].state, step).toBe("done");
    expect(s.cost.usd).toBeGreaterThan(0.1);
    expect(effects.some((f) => f.k === "wait")).toBe(true);
    expect(effects.some((f) => f.k === "whiteboard")).toBe(true);
    expect(effects.filter((f) => f.k === "handoff").length).toBeGreaterThanOrEqual(3);
  });
});
