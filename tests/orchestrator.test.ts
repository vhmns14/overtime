import { describe, expect, it } from "vitest";
import { Orchestrator, DEFAULT_CONFIG, type OrchestratorDeps } from "../src/engine/orchestrator";
import { DemoLLM, DEMO_TASK, DEMO_PRICING } from "../src/demo/demo-llm";
import type { CompletionRequest, CompletionResult, GateRequest, LLM, RunConfig, RunEvent } from "../src/engine/types";

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return { ...DEFAULT_CONFIG, task: DEMO_TASK, pricing: DEMO_PRICING, budgetUsd: 5, ...over, gates: { ...DEFAULT_CONFIG.gates, ...(over.gates ?? {}) } };
}

function make(deps: Partial<OrchestratorDeps> & { config: RunConfig }) {
  const deployed: Record<string, string>[] = [];
  const o = new Orchestrator({
    llm: new DemoLLM({ speed: 0 }),
    runId: "test-run-1",
    deploy: async (_id, files) => { deployed.push(files); return { url: "/p/test-run-1/", local: false }; },
    ...deps,
  });
  const events: RunEvent[] = [];
  o.on((e) => events.push(e));
  return { o, events, deployed };
}

/** auto-answers gates with a scripted list of decisions */
function autoGates(o: Orchestrator, answers: Record<string, "approve" | "reject" | "comment">[] = [], fallback: "approve" | "reject" = "approve", seen: GateRequest[] = []) {
  let i = 0;
  o.on((e) => {
    if (e.type === "gate") {
      seen.push(e.gate);
      const a = answers[i++]?.[e.gate.kind] ?? fallback;
      queueMicrotask(() => o.decide(e.gate.id, { action: a, comment: a === "approve" ? undefined : "make it simpler" }));
    }
  });
  return seen;
}

class ScriptLLM implements LLM {
  label = "script";
  calls: CompletionRequest[] = [];
  constructor(private replies: ((req: CompletionRequest) => string)[], private usage = { prompt: 100, completion: 50 }) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ ...req, messages: [...req.messages] });
    const f = this.replies.shift();
    if (!f) throw new Error("script exhausted");
    return { text: f(req), usage: this.usage };
  }
}

describe("orchestrator: demo run end to end", () => {
  it("plans, researches, codes, catches 2 failures, fixes them and deploys", async () => {
    const { o, events, deployed } = make({ config: cfg() });
    const gates = autoGates(o);
    const status = await o.run();
    expect(status).toBe("done");
    expect(gates.map((g) => g.kind)).toEqual(["plan", "review", "deploy"]);
    const review = gates[1];
    expect(review.title).toMatch(/2 tests failing, fix before deploy/);
    expect(review.diff?.some((d) => d.type === "del" && d.text.includes("css/styles.css"))).toBe(true);
    const checks = events.filter((e) => e.type === "checks") as Extract<RunEvent, { type: "checks" }>[];
    expect(checks).toHaveLength(2);
    expect(checks[0].report.failures).toBe(2);
    expect(checks[0].report.results.find((r) => r.id === "links")!.status).toBe("fail");
    expect(checks[0].report.results.find((r) => r.id === "alt")!.status).toBe("fail");
    expect(checks[1].report.ok).toBe(true);
    expect(o.snapshots.map((s) => s.label)).toEqual(["Coder v1", "Coder v2 (fix round 1)"]);
    expect(deployed).toHaveLength(1);
    expect(Object.keys(deployed[0]).sort()).toEqual(["css/style.css", "img/senja-cup.svg", "index.html", "js/main.js"]);
    expect(deployed[0]["notes/brief.md"]).toBeUndefined();
    expect(o.tickets.every((t) => t.status === "done")).toBe(true);
    expect(o.steps.deploy.state).toBe("done");
    expect(o.usage.tokens).toBeGreaterThan(5000);
    expect(o.usage.usd).toBeGreaterThan(0);
    const byAgent = events.filter((e) => e.type === "cost").pop() as Extract<RunEvent, { type: "cost" }>;
    expect(Object.values(byAgent.byAgent).reduce((n, a) => n + a.tokens, 0)).toBe(o.usage.tokens);
  });

  it("is deterministic", async () => {
    const a = make({ config: cfg() }); autoGates(a.o); await a.o.run();
    const b = make({ config: cfg() }); autoGates(b.o); await b.o.run();
    expect(a.o.usage).toEqual(b.o.usage);
    expect(a.o.files).toEqual(b.o.files);
  });

  it("runs straight through with every gate off", async () => {
    const { o, events } = make({ config: cfg({ gates: { plan: false, deploy: false, review: false } }) });
    expect(await o.run()).toBe("done");
    expect(events.some((e) => e.type === "gate")).toBe(false);
    expect(o.lastReport?.ok).toBe(true);
  });
});

describe("orchestrator: approval flow", () => {
  it("plan rejection sends the comment back to the PM, who re-plans", async () => {
    const llm = new DemoLLM({ speed: 0 });
    const seen: CompletionRequest[] = [];
    const spy: LLM = { label: "spy", complete: (r) => { seen.push(r); return llm.complete(r); } };
    const { o } = make({ config: cfg(), llm: spy });
    const gates = autoGates(o, [{ plan: "reject" }]);
    expect(await o.run()).toBe("done");
    expect(gates.filter((g) => g.kind === "plan")).toHaveLength(2);
    const pmCalls = seen.filter((r) => r.agent === "pm");
    expect(pmCalls).toHaveLength(2);
    expect(pmCalls[1].messages[1].content).toContain("FEEDBACK FROM THE HUMAN (follow it): make it simpler");
  });

  it("rejecting reviewer fixes ships as is and marks review failed", async () => {
    const { o, deployed } = make({ config: cfg() });
    autoGates(o, [{ plan: "approve" }, { review: "reject" }]);
    expect(await o.run()).toBe("done");
    expect(o.steps.review.state).toBe("failed");
    expect(deployed[0]["index.html"]).toContain("css/styles.css");
  });

  it("rejecting deploy skips it but keeps the files", async () => {
    const { o, deployed } = make({ config: cfg() });
    autoGates(o, [{ plan: "approve" }, { review: "approve" }, { deploy: "reject" }]);
    expect(await o.run()).toBe("done");
    expect(deployed).toHaveLength(0);
    expect(o.steps.deploy.state).toBe("skipped");
    expect(Object.keys(o.files)).toContain("index.html");
  });

  it("ignores decisions for a gate that is not open", async () => {
    const { o } = make({ config: cfg() });
    expect(o.decide("g99", { action: "approve" })).toBe(false);
  });
});

describe("orchestrator: control", () => {
  it("cancel while waiting at a gate ends the run as cancelled", async () => {
    const { o } = make({ config: cfg() });
    o.on((e) => { if (e.type === "gate") queueMicrotask(() => o.cancel()); });
    expect(await o.run()).toBe("cancelled");
  });

  it("pause holds the run until resume", async () => {
    const { o } = make({ config: cfg({ gates: { plan: false, deploy: false, review: false } }) });
    let pausedAt = -1;
    o.on((e) => {
      if (e.type === "handoff" && e.from === "pm" && pausedAt < 0) {
        o.pause();
        pausedAt = o.log.length;
        setTimeout(() => { expect(o.status).toBe("paused"); expect(o.log.length).toBe(pausedAt); o.resume(); }, 30);
      }
    });
    expect(await o.run()).toBe("done");
  });

  it("stops when the budget cap is exceeded", async () => {
    const { o, deployed } = make({ config: cfg({ budgetUsd: 0.02 }) });
    autoGates(o);
    expect(await o.run()).toBe("budget");
    expect(o.usage.usd).toBeGreaterThan(0.02);
    expect(deployed).toHaveLength(0);
    expect(o.error).toMatch(/Budget cap/);
  });
});

describe("orchestrator: model output validation", () => {
  it("retries after invalid JSON and wrong tools, then fails after 3 in a row", async () => {
    const bad = () => "Sure! Here is my plan: build it.";
    const llm = new ScriptLLM([bad, () => JSON.stringify({ thought: "x", tool: "write_file", args: { path: "a.html", content: "x" } }), bad]);
    const { o } = make({ config: cfg(), llm });
    expect(await o.run()).toBe("failed");
    expect(o.error).toMatch(/invalid replies/);
    expect(llm.calls[1].messages.at(-1)!.content).toMatch(/^ERROR: No JSON object/);
    expect(llm.calls[2].messages.at(-1)!.content).toMatch(/not available to pm/);
  });

  it("accepts JSON wrapped in prose and code fences", async () => {
    const plan = () => "Here you go:\n```json\n" + JSON.stringify({ thought: "plan", tool: "handoff", args: { to: "research", summary: "go", tickets: [{ id: "T1", title: "Build", owner: "coder" }] } }) + "\n```";
    const llm = new ScriptLLM([plan, () => { throw new Error("stop here"); }]);
    const { o } = make({ config: cfg({ gates: { plan: false, deploy: true, review: true } }), llm });
    await o.run();
    expect(o.tickets[0].title).toBe("Build");
    expect(o.steps.plan.state).toBe("done");
  });

  it("refuses paths outside the project and research writes outside notes/", async () => {
    const steps = [
      () => JSON.stringify({ thought: "p", tool: "handoff", args: { to: "research", summary: "s", tickets: [] } }),
      () => JSON.stringify({ thought: "r", tool: "write_file", args: { path: "index.html", content: "x" } }),
      () => JSON.stringify({ thought: "r", tool: "write_file", args: { path: "../../etc/passwd.txt", content: "x" } }),
      () => JSON.stringify({ thought: "r", tool: "handoff", args: { to: "coder", summary: "s" } }),
    ];
    const llm = new ScriptLLM([...steps, () => { throw new Error("stop"); }]);
    const { o } = make({ config: cfg({ gates: { plan: false, deploy: false, review: false } }), llm });
    await o.run();
    expect(llm.calls[2].messages.at(-1)!.content).toMatch(/research may only write under notes/);
    expect(llm.calls[3].messages.at(-1)!.content).toMatch(/invalid path/);
    expect(Object.keys(o.files)).toEqual([]);
  });

  it("an agent that never hands off fails after maxSteps", async () => {
    const loop = () => JSON.stringify({ thought: "q", tool: "ask_user", args: { question: "?" } });
    const llm = new ScriptLLM(Array.from({ length: 5 }, () => loop));
    const { o } = make({ config: cfg({ maxStepsPerAgent: 3 }), llm });
    autoGates(o);
    expect(await o.run()).toBe("failed");
    expect(o.error).toMatch(/did not finish within 3 steps/);
  });
});
