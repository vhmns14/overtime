import { describe, expect, it } from "vitest";
import { parseToolCall, extractJsonObject, safePath, ROLE_TOOLS } from "../src/engine/schema";
import { lineDiff, compactDiff, diffStats } from "../src/engine/diff";
import { buildZip, crc32 } from "../src/engine/zip";
import { OpenAICompatibleLLM, redact, costOf, PRESETS } from "../src/engine/llm";

describe("tool call parsing", () => {
  it("extracts the first balanced object even with braces inside strings", () => {
    expect(extractJsonObject('pre {"a":"}{","b":{"c":1}} post {"z":1}')).toBe('{"a":"}{","b":{"c":1}}');
    expect(extractJsonObject("no json")).toBeNull();
    expect(extractJsonObject('{bad} then {"ok":true}')).toBe('{"ok":true}');
  });
  it("validates tools, roles, required args, types, enums and sizes", () => {
    const call = (o: unknown, role: Parameters<typeof parseToolCall>[1] = "coder") => parseToolCall(JSON.stringify(o), role);
    expect(call({ thought: "t", tool: "write_file", args: { path: "a.html", content: "x" } }).ok).toBe(true);
    expect(call({ tool: "write_file", args: { path: "a.html" } })).toMatchObject({ ok: false, error: expect.stringMatching(/missing required arg "content"/) });
    expect(call({ tool: "write_file", args: { path: 3, content: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/must be string/) });
    expect(call({ tool: "run_checks", args: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/not available to coder/) });
    expect(call({ tool: "handoff", args: { to: "boss", summary: "s" } })).toMatchObject({ ok: false, error: expect.stringMatching(/must be one of/) });
    expect(call({ tool: "nope" })).toMatchObject({ ok: false });
    expect(call({ tool: "handoff", args: { to: "ops", summary: "x".repeat(401) } }, "reviewer")).toMatchObject({ ok: false, error: expect.stringMatching(/longer than 400/) });
    expect(call({ tool: "list_files", args: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/args/) });
  });
  it("each role gets only its own tools", () => {
    expect(ROLE_TOOLS.pm).not.toContain("write_file");
    expect(ROLE_TOOLS.ops).not.toContain("write_file");
    expect(ROLE_TOOLS.reviewer).toContain("run_checks");
  });
  it("safePath refuses traversal, absolute tricks and non-static types", () => {
    expect(safePath("./css/a.css")).toBe("css/a.css");
    expect(safePath("/index.html")).toBe("index.html");
    expect(safePath("../x.html")).toBeNull();
    expect(safePath("a//b.html")).toBeNull();
    expect(safePath("run.sh")).toBeNull();
    expect(safePath("C:\\x.html")).toBeNull();
  });
});

describe("diff, zip, llm client", () => {
  it("line diff + compaction", () => {
    const d = lineDiff("a\nb\nc\nd\ne", "a\nB\nc\nd\ne\nf");
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(compactDiff(d, 0).map((l) => l.type + l.text)).toEqual(["ctx…", "delb", "addB", "ctx…", "addf"]);
  });
  it("zip has valid structure and CRCs", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    const z = buildZip({ "index.html": "<p>hi</p>", "css/a.css": "a{}" }, "site");
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(2);
    expect(new TextDecoder().decode(z)).toContain("site/css/a.css");
  });
  it("sends the key only in the Authorization header and redacts it from errors", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ error: "bad key sk-test-1234567890abcdef" }), { status: 401 });
    }) as unknown as typeof fetch;
    const llm = new OpenAICompatibleLLM({ baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "sk-test-1234567890abcdef", route: "proxy", jsonMode: true }, fake);
    await expect(llm.complete({ agent: "pm", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/\[redacted\]/);
    expect(seen).toHaveLength(1); // 401 is not retried
    expect(seen[0].url).toBe("/api/llm");
    const h = seen[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk-test-1234567890abcdef");
    expect(h["x-ot-base-url"]).toBe("https://api.openai.com/v1");
    expect(String(seen[0].init.body)).not.toContain("sk-test");
  });
  it("retries 429/5xx, falls back when JSON mode is unsupported, reads usage", async () => {
    const replies = [
      new Response("rate limited", { status: 429 }),
      new Response("response_format json_object is not supported", { status: 400 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"finish"}' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } })),
    ];
    const bodies: string[] = [];
    const fake = (async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return replies.shift()!; }) as unknown as typeof fetch;
    const llm = new OpenAICompatibleLLM({ baseUrl: "https://x.test/v1", model: "m", apiKey: "", route: "direct", jsonMode: true }, fake);
    (globalThis as { setTimeout: unknown }).setTimeout;
    const r = await llm.complete({ agent: "pm", messages: [{ role: "user", content: "hi" }] });
    expect(r).toEqual({ text: '{"tool":"finish"}', usage: { prompt: 11, completion: 7 } });
    expect(bodies[0]).toContain("response_format");
    expect(bodies[2]).not.toContain("response_format");
  }, 15_000);
  it("redact + cost", () => {
    expect(redact("Bearer abc.def gsk_ABCDEFGHIJKLMNOP")).toBe("Bearer [redacted] [redacted]");
    expect(costOf({ prompt: 1_000_000, completion: 1_000_000 }, { input: 1, output: 2 })).toBe(3);
    expect(PRESETS.map((p) => p.id)).toEqual(["openrouter", "groq", "openai", "ollama"]);
    expect(PRESETS[0].freeModel).toBe("openrouter/free");
  });
});
