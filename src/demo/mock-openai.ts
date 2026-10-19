// A stand-in OpenAI-compatible /chat/completions server for tests and the smoke script's mock mode.
// It replays the recorded demos, answering in whichever format the request asked for: native tool
// calls when `tools` is present, otherwise a JSON message (optionally wrapped in a code fence to
// exercise the repair path).

import { demoReply } from "./demo-llm";
import { demoRepoReply } from "./demo-repo";
import type { ChatMessage, CompletionRequest, Role } from "../engine/types";

const ROLE_BY_PROMPT: [RegExp, Role][] = [[/You are the PM/, "pm"], [/You are the Researcher/, "research"], [/You are the Coder/, "coder"], [/You are the Reviewer/, "reviewer"], [/You are Ops/, "ops"]];

export function roleOf(messages: ChatMessage[]): Role {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  return ROLE_BY_PROMPT.find(([re]) => re.test(sys))?.[1] ?? "pm";
}

export interface MockOpts {
  /** wrap JSON replies in ```json fences with a sentence of prose */
  sloppy?: boolean;
  /** fail the first N calls with this status */
  failFirst?: { n: number; status: number; retryAfter?: string };
  /** reject `tools` with a 400 like providers without tool support */
  noTools?: boolean;
}

export function mockOpenAI(opts: MockOpts = {}) {
  let calls = 0;
  const log: { tools: boolean; json: boolean; model: string }[] = [];
  const handler = async (body: { model: string; messages: ChatMessage[]; tools?: unknown[]; response_format?: unknown }): Promise<{ status: number; headers: Record<string, string>; json: unknown }> => {
    calls++;
    log.push({ tools: !!body.tools, json: !!body.response_format, model: body.model });
    if (opts.failFirst && calls <= opts.failFirst.n) return { status: opts.failFirst.status, headers: opts.failFirst.retryAfter ? { "retry-after": opts.failFirst.retryAfter } : {}, json: { error: { message: "Rate limit exceeded" } } };
    if (opts.noTools && body.tools) return { status: 400, headers: {}, json: { error: { message: "tools is not supported for this model" } } };
    const agent = roleOf(body.messages);
    const repo = body.messages.some((m) => /REPOSITORY |existing (?:code )?repository/i.test(m.content));
    const req: CompletionRequest = { agent, messages: body.messages };
    const text = repo ? demoRepoReply(req) : demoReply(req);
    const usage = { prompt_tokens: Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4), completion_tokens: Math.ceil(text.length / 4) };
    if (body.tools) {
      const call = JSON.parse(text) as { thought: string; tool: string; args: Record<string, unknown> };
      return { status: 200, headers: {}, json: { model: body.model, choices: [{ message: { content: null, tool_calls: [{ id: `call_${calls}`, type: "function", function: { name: call.tool, arguments: JSON.stringify({ thought: call.thought, ...call.args }) } }] }, finish_reason: "tool_calls" }], usage } };
    }
    const content = opts.sloppy ? `Sure! Here is my next step:\n\`\`\`json\n${text}\n\`\`\`` : text;
    return { status: 200, headers: {}, json: { model: body.model, choices: [{ message: { content }, finish_reason: "stop" }], usage } };
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const r = await handler(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { handler, fetch: fetchImpl, log, get calls() { return calls; } };
}
