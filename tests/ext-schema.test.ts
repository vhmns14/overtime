import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateEvent, unpackBatch, EVENT_TYPES, DATA_SPEC, LIMITS } from "../src/ext/schema";
import { redactDeep, redactString, isSensitiveKey } from "../src/ext/redact";

describe("event schema v1", () => {
  it("accepts every documented type with minimal data", () => {
    const minimal: Record<string, Record<string, unknown>> = {
      "tool.start": { name: "web_search" }, "tool.end": { name: "web_search", ok: true }, "file.write": { path: "a.py" },
      "plan.update": { items: [{ text: "x" }] }, "subagent.start": { id: "s1" }, "subagent.stop": { id: "s1" },
      message: { role: "user", text: "hi" }, error: { message: "boom" },
    };
    for (const t of EVENT_TYPES) {
      const r = validateEvent({ type: t, data: minimal[t] ?? {} });
      expect(r.ok, t).toBe(true);
    }
  });

  it("rejects unknown types, versions, bad ids and missing required fields", () => {
    expect(validateEvent({ type: "tool.explode", data: {} })).toMatchObject({ ok: false });
    expect(validateEvent({ v: 2, type: "message", data: { role: "user", text: "x" } })).toMatchObject({ ok: false, error: expect.stringContaining("version") });
    expect(validateEvent({ type: "tool.start", data: {} })).toMatchObject({ ok: false, error: expect.stringContaining("data.name is required") });
    expect(validateEvent({ type: "tool.end", data: { name: "x", ok: "yes" } })).toMatchObject({ ok: false, error: expect.stringContaining("boolean") });
    expect(validateEvent({ type: "llm.call", data: { input_tokens: -1 } })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "message", data: { role: "system", text: "x" } })).toMatchObject({ ok: false, error: expect.stringContaining("one of") });
    expect(validateEvent({ type: "message", session: "has space", data: { role: "user", text: "x" } })).toMatchObject({ ok: false });
    expect(validateEvent("nope")).toMatchObject({ ok: false });
    expect(validateEvent({ type: "message", ts: "yesterday-ish", data: { role: "user", text: "x" } })).toMatchObject({ ok: false });
  });

  it("normalizes ts (ms, seconds, ISO), defaults session/agent, drops unknown data fields, clips strings", () => {
    const now = 1_790_000_000_000;
    const a = validateEvent({ type: "agent.thinking", ts: 1_790_000_000, data: { text: "x".repeat(10_000), sneaky: "<script>" } }, now);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.event.ts).toBe(1_790_000_000_000);
    expect(a.event.session).toBe("default");
    expect(a.event.agent).toBe("main");
    expect((a.event.data as Record<string, unknown>).sneaky).toBeUndefined();
    expect((a.event.data as { text: string }).text.length).toBe(LIMITS.text);
    const b = validateEvent({ type: "session.start", ts: "2026-10-19T09:00:00Z", data: {} }, now);
    expect(b.ok && b.event.ts).toBe(Date.parse("2026-10-19T09:00:00Z"));
  });

  it("keeps plan items bounded and maps unknown statuses to todo", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ text: `step ${i}`, status: i % 2 ? "done" : "weird" }));
    const r = validateEvent({ type: "plan.update", data: { items } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = (r.event.data as { items: { status: string }[] }).items;
      expect(out).toHaveLength(LIMITS.planItems);
      expect(out[0].status).toBe("todo");
      expect(out[1].status).toBe("done");
    }
  });

  it("unpacks single events, arrays and {events:[…]}", () => {
    expect(unpackBatch({ type: "message" })).toHaveLength(1);
    expect(unpackBatch([{}, {}])).toHaveLength(2);
    expect(unpackBatch({ events: [{}, {}, {}] })).toHaveLength(3);
    expect(unpackBatch({ nope: 1 })).toBeNull();
  });

  it("the JSON Schema documents exactly the types and data fields the validator knows", () => {
    const schema = JSON.parse(readFileSync("docs/events.schema.json", "utf8"));
    const types = schema.properties.type.enum as string[];
    expect(types.sort()).toEqual([...EVENT_TYPES].sort());
    for (const t of EVENT_TYPES) {
      const branch = (schema.allOf as { if: { properties: { type: { const: string } } }; then: { properties: { data: { properties: Record<string, unknown>; required?: string[] } } } }[]).find((b) => b.if.properties.type.const === t);
      expect(branch, t).toBeTruthy();
      expect(Object.keys(branch!.then.properties.data.properties).sort(), t).toEqual(Object.keys(DATA_SPEC[t]).sort());
      const req = Object.entries(DATA_SPEC[t]).filter(([, f]) => f.req).map(([k]) => k).sort();
      expect((branch!.then.properties.data.required ?? []).sort(), t).toEqual(req);
    }
  });
});

describe("redaction", () => {
  const cases: [string, RegExp][] = [
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456", /sk-proj/],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'", /abcdefghijklmnop/],
    ["key sk-or-v1-0123456789abcdef0123456789abcdef", /sk-or-v1-0123/],
    ["git push https://user:hunter2hunter2@github.com/x/y", /hunter2/],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", /ghp_abc/],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", /github_pat_11/],
    ["aws AKIAABCDEFGHIJKLMNOP", /AKIAABCD/],
    ["DB_PASSWORD=correct-horse-battery", /correct-horse/],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", /eyJzdWIi/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", /MIIEpA/],
    ["OVERTIME_TOKEN=ot_ing_abcdefghijklmnopqrstuvwxyz", /ot_ing_abc/],
    ["slack xoxb-1234567890-abcdefghij", /xoxb-1234/],
  ];
  for (const [input, leak] of cases) it(`redacts ${input.slice(0, 32)}…`, () => {
    const out = redactString(input);
    expect(out).not.toMatch(leak);
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary text, token counts and paths alone", () => {
    expect(redactString("python -m pytest -q tests/test_health.py")).toBe("python -m pytest -q tests/test_health.py");
    expect(redactDeep({ input_tokens: 120, output_tokens: 30, max_tokens: 9 })).toEqual({ input_tokens: 120, output_tokens: 30, max_tokens: 9 });
  });

  it("drops values under secret-looking keys, at any depth", () => {
    expect(redactDeep({ a: { api_key: "x", headers: { Authorization: "y" }, token: "z", password: "p" } })).toEqual({ a: { api_key: "[redacted]", headers: { Authorization: "[redacted]" }, token: "[redacted]", password: "[redacted]" } });
    expect(isSensitiveKey("client_secret")).toBe(true);
    expect(isSensitiveKey("input_tokens")).toBe(false);
  });

  it("validation redacts before anything is stored", () => {
    const r = validateEvent({ type: "tool.start", data: { name: "terminal", args_summary: "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv claude" } });
    expect(r.ok && (r.event.data as { args_summary: string }).args_summary).toBe("ANTHROPIC_API_KEY=[redacted] claude");
  });
});
