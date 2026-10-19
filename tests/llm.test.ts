import { describe, expect, it } from "vitest";
import { OpenAICompatibleLLM, backoffMs, retryAfterMs, testConnection, toolCallToText, type LLMSettings } from "../src/engine/llm";
import { parseToolCall, repairJson, toolSpecs } from "../src/engine/schema";
import { mockOpenAI } from "../src/demo/mock-openai";
import { Orchestrator, DEFAULT_CONFIG } from "../src/engine/orchestrator";
import { DEMO_TASK } from "../src/demo/demo-llm";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const base = (extra: Partial<LLMSettings> = {}): LLMSettings => ({ baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: KEY, route: "direct", jsonMode: true, ...extra });
const msgs = [{ role: "user" as const, content: "hi" }];

describe("JSON repair", () => {
  it("repairs fences, prose, trailing commas, raw newlines, smart quotes and missing closers", () => {
    const cases = [
      'Sure!\n```json\n{"thought": "t", "tool": "finish", "args": {"summary": "x",},}\n```',
      '{"thought": "multi\nline", "tool": "finish", "args": {"summary": "a"}}',
      '{“thought”: “t”, “tool”: “finish”, “args”: {“summary”: “s”}}',
      '{"thought": "t", "tool": "finish", "args": {"summary": "cut off',
    ];
    for (const c of cases) {
      const r = parseToolCall(c, "ops");
      expect(r.ok, c).toBe(true);
    }
    expect(repairJson("no braces here")).toBeNull();
    expect(JSON.parse(repairJson('{"a": [1, 2,')!)).toEqual({ a: [1, 2] });
  });
  it("still reports a precise error when the reply cannot be repaired", () => {
    expect(parseToolCall("I think we should write the file now.", "coder")).toMatchObject({ ok: false, error: expect.stringMatching(/No JSON object/) });
  });
});

describe("tool calling", () => {
  it("builds OpenAI function specs per role and mode", () => {
    const specs = toolSpecs("coder", "repo");
    expect(specs.map((s) => s.function.name)).toEqual(["list_files", "read_file", "search_repo", "write_file", "edit_file", "delete_file", "handoff"]);
    const edit = specs.find((s) => s.function.name === "edit_file")!.function.parameters as { required: string[]; properties: Record<string, { type: string }> };
    expect(edit.required).toEqual(["thought", "path", "edits"]);
    expect(edit.properties.edits.type).toBe("array");
  });
  it("converts a native tool call back into the JSON protocol", () => {
    const t = toolCallToText(null, { function: { name: "write_file", arguments: '{"thought":"x","path":"a.html","content":"<p>"}' } });
    expect(JSON.parse(t)).toEqual({ thought: "x", tool: "write_file", args: { path: "a.html", content: "<p>" } });
  });
  it("sends tools + tool_choice and downgrades tools → JSON mode → prompt when the provider refuses", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      new Response(JSON.stringify({ error: { message: "This model does not support tool use" } }), { status: 400 }),
      new Response(JSON.stringify({ error: { message: "response_format is not supported" } }), { status: 400 }),
      new Response(JSON.stringify({ model: "m-123", choices: [{ message: { content: '{"thought":"t","tool":"finish","args":{"summary":"s"}}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } })),
    ];
    const llm = new OpenAICompatibleLLM(base(), async (_u, init) => { bodies.push(JSON.parse(String(init!.body))); return replies.shift()!; });
    const r = await llm.complete({ agent: "ops", messages: msgs, tools: toolSpecs("ops") });
    expect(r.usage).toEqual({ prompt: 5, completion: 3 });
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[0].tool_choice).toBe("required");
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[2].response_format).toBeUndefined();
    expect(llm.output).toBe("prompt");
    expect(llm.lastModel).toBe("m-123");
  });
});

describe("rate limits and retries", () => {
  it("429 with Retry-After waits that long, then succeeds; 5xx-in-200 is retried too", async () => {
    const waits: number[] = [];
    const replies = [
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429, headers: { "retry-after": "7" } }),
      new Response(JSON.stringify({ error: { message: "upstream overloaded", code: 502 } }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })),
    ];
    const retries: number[] = [];
    const llm = new OpenAICompatibleLLM(base({ output: "prompt", sleep: async (ms) => { waits.push(ms); }, onRetry: (r) => retries.push(r.status) }), async () => replies.shift()!);
    await llm.complete({ agent: "pm", messages: msgs });
    expect(waits[0]).toBe(7000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000); // exponential: attempt 1 → 2 s + jitter
    expect(retries).toEqual([429, 502]);
  });
  it("gives up after maxRetries and reports a redacted error", async () => {
    let n = 0;
    const llm = new OpenAICompatibleLLM(base({ output: "prompt", maxRetries: 2, sleep: async () => {} }), async () => { n++; return new Response(`{"error":{"message":"slow down ${KEY}"}}`, { status: 429 }); });
    const err = (await llm.complete({ agent: "pm", messages: msgs }).catch((e) => e)) as Error;
    expect(n).toBe(3);
    expect(err.message).toMatch(/LLM 429 \(rate limited\)/);
    expect(err.message).not.toContain(KEY);
  });
  it("does not retry 401/402", async () => {
    let n = 0;
    const llm = new OpenAICompatibleLLM(base({ sleep: async () => {} }), async () => { n++; return new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 }); });
    await expect(llm.complete({ agent: "pm", messages: msgs })).rejects.toThrow(/401 \(check the API key\)/);
    expect(n).toBe(1);
  });
  it("Retry-After parsing and backoff caps", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(backoffMs(10)).toBeLessThanOrEqual(30_250);
    expect(backoffMs(0, 999_999)).toBe(60_000);
  });
});

describe("streaming", () => {
  it("assembles SSE deltas, tool call fragments and usage", async () => {
    const sse = [
      'data: {"model":"m-s","choices":[{"delta":{"content":"{\\"thought\\":\\"t\\","}}]}',
      'data: {"choices":[{"delta":{"content":"\\"tool\\":\\"finish\\",\\"args\\":{\\"summary\\":\\"s\\"}}"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
      "data: [DONE]", "",
    ].join("\n");
    const chunks: string[] = [];
    const llm = new OpenAICompatibleLLM(base({ output: "prompt", stream: true }), async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const r = await llm.complete({ agent: "ops", messages: msgs, onToken: (c) => chunks.push(c) });
    expect(JSON.parse(r.text).tool).toBe("finish");
    expect(r.usage).toEqual({ prompt: 9, completion: 4 });
    expect(chunks).toHaveLength(2);
  });
});

describe("test connection", () => {
  it("reports model and latency, or a redacted error", async () => {
    const ok = await testConnection(base(), async () => new Response(JSON.stringify({ model: "openai/gpt-4o-mini-2024", choices: [{ message: { content: "OK" } }] })));
    expect(ok).toMatchObject({ ok: true, model: "openai/gpt-4o-mini-2024" });
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    const bad = await testConnection(base(), async () => new Response(`{"error":{"message":"invalid key ${KEY}"}}`, { status: 401 }));
    expect(bad.ok).toBe(false);
    expect(bad.error).not.toContain(KEY);
    const reasoning = await testConnection(base(), async () => new Response(JSON.stringify({ model: "r1", choices: [{ message: { content: "" }, finish_reason: "length" }] })));
    expect(reasoning.ok).toBe(true);
  });
});

describe("orchestrator over the real HTTP client (mock provider)", () => {
  it("runs the whole Kopi Senja task with native tool calls", async () => {
    const mock = mockOpenAI();
    const llm = new OpenAICompatibleLLM(base(), mock.fetch);
    const o = new Orchestrator({ llm, runId: "t-http", config: { ...DEFAULT_CONFIG, task: DEMO_TASK, budgetUsd: 5 }, deploy: async () => ({ url: "", local: true }) });
    o.on((e) => { if (e.type === "gate") queueMicrotask(() => o.decide(e.gate.id, { action: "approve" })); });
    expect(await o.run()).toBe("done");
    expect(mock.log.every((c) => c.tools)).toBe(true);
    expect(o.lastReport?.ok).toBe(true);
  });
  it("and with sloppy fenced JSON from a provider without tool support", async () => {
    const mock = mockOpenAI({ noTools: true, sloppy: true, failFirst: { n: 1, status: 429, retryAfter: "0" } });
    const llm = new OpenAICompatibleLLM(base({ sleep: async () => {} }), mock.fetch);
    const o = new Orchestrator({ llm, runId: "t-http2", config: { ...DEFAULT_CONFIG, task: DEMO_TASK, budgetUsd: 5, gates: { plan: false, review: false, deploy: false } }, deploy: async () => ({ url: "", local: true }) });
    expect(await o.run()).toBe("done");
    expect(llm.output).toBe("json");
    expect(o.log.filter((l) => /invalid reply/.test(l.text))).toHaveLength(0);
  });
});
