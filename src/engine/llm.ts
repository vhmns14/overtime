// Bring-your-own-key client for any OpenAI-compatible /chat/completions endpoint.
// The key lives in the browser; each request carries it either straight to the provider (when the
// provider allows CORS) or through the Worker's stateless /api/llm proxy, which never stores or logs it.
//
// Output protocol, most to least structured, with automatic fallback when a provider refuses one:
//   "tools"  native tool calling (tools + tool_choice "required"), converted back to our JSON call
//   "json"   response_format json_object + the JSON protocol in the prompt
//   "prompt" plain prompting; the orchestrator's parser repairs almost-JSON and asks again if needed

import type { ChatMessage, CompletionRequest, CompletionResult, LLM, Pricing } from "./types";

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  pricing: Pricing;
  /** request route that works out of the box for this provider */
  route: "proxy" | "direct";
  /** a $0 model to try first, if the provider has one */
  freeModel?: string;
  /** native tool calling generally works on this provider */
  tools: boolean;
}

export const PRESETS: Preset[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", pricing: { input: 0.15, output: 0.6 }, route: "proxy", freeModel: "openrouter/free", tools: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", pricing: { input: 0.59, output: 0.79 }, route: "proxy", tools: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", pricing: { input: 0.15, output: 0.6 }, route: "proxy", tools: true },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", pricing: { input: 0, output: 0 }, route: "direct", tools: false },
];

export type OutputMode = "auto" | "tools" | "json" | "prompt";

export interface LLMSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  route: "proxy" | "direct";
  /** legacy switch: false = never ask for JSON mode */
  jsonMode: boolean;
  output?: OutputMode;
  stream?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
  /** retries for 429 / 5xx / network (default 4) */
  maxRetries?: number;
  /** where the proxy lives (same origin by default) */
  proxyUrl?: string;
  /** for tests: replaces setTimeout-based waiting */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** called before each retry wait (UI log) */
  onRetry?: (info: { attempt: number; waitMs: number; status: number; reason: string }) => void;
}

export class LLMError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = false, readonly retryAfterMs?: number) {
    super(message);
    this.name = "LLMError";
  }
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Scrubs anything that looks like a credential before an error reaches the log. */
export function redact(s: string, secret?: string) {
  let out = String(s);
  if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out
    .replace(/(sk|gsk|or|ghp|gho|ghu|ghs|ghr|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(sk-or-v1-)[A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/("?(?:authorization|x-ot-gh-token|api[_-]?key)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]");
}

/** Parses Retry-After (seconds or HTTP date) into ms. */
export function retryAfterMs(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

export function backoffMs(attempt: number, retryAfter?: number) {
  if (retryAfter !== undefined) return Math.min(60_000, Math.max(250, retryAfter));
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
}

/** Turns a native tool call back into the {"thought","tool","args"} protocol the orchestrator parses. */
export function toolCallToText(content: string | null | undefined, call?: { function?: { name?: string; arguments?: string } }): string {
  if (!call?.function?.name) return content ?? "";
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { return JSON.stringify({ thought: content ?? "", tool: call.function.name, args: {}, _raw: call.function.arguments }); }
  const { thought, ...rest } = args;
  return JSON.stringify({ thought: typeof thought === "string" ? thought : (content ?? "").slice(0, 300), tool: call.function.name, args: rest });
}

export class OpenAICompatibleLLM implements LLM {
  readonly label: string;
  /** current protocol (may be downgraded at runtime when the provider refuses one) */
  output: Exclude<OutputMode, "auto">;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  lastModel = "";

  constructor(private s: LLMSettings, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.label = `${s.model} @ ${new URL(s.baseUrl).host}`;
    const o = s.output ?? "auto";
    this.output = o === "auto" ? (s.jsonMode === false ? "prompt" : "tools") : o;
    this.sleep = s.sleep ?? realSleep;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const max = this.s.maxRetries ?? 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= max + 2; attempt++) {
      try {
        return await this.once(req);
      } catch (e) {
        lastErr = e;
        if ((e as Error).name === "AbortError" && req.signal?.aborted) throw e;
        if (e instanceof LLMError && e.status === -1) continue; // protocol downgrade: retry at once, does not count
        const retryable = e instanceof LLMError ? e.retryable : (e as Error).name === "TimeoutError" || e instanceof TypeError;
        if (!retryable || attempt >= max) break;
        const wait = backoffMs(attempt, e instanceof LLMError ? e.retryAfterMs : undefined);
        this.s.onRetry?.({ attempt: attempt + 1, waitMs: wait, status: e instanceof LLMError ? e.status : 0, reason: (e as Error).message.slice(0, 120) });
        await this.sleep(wait, req.signal);
      }
    }
    throw lastErr;
  }

  private url() {
    return this.s.route === "direct" ? this.s.baseUrl.replace(/\/+$/, "") + "/chat/completions" : (this.s.proxyUrl ?? "/api/llm");
  }

  private headers() {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.s.apiKey) headers.authorization = `Bearer ${this.s.apiKey}`;
    if (this.s.route !== "direct") headers["x-ot-base-url"] = this.s.baseUrl;
    else if (/openrouter\.ai/.test(this.s.baseUrl)) { headers["http-referer"] = "https://github.com/vhmns14/overtime"; headers["x-title"] = "Overtime"; }
    return headers;
  }

  private body(req: CompletionRequest, messages: ChatMessage[]) {
    const body: Record<string, unknown> = { model: this.s.model, messages, temperature: 0.2, max_tokens: this.s.maxTokens ?? 4096 };
    if (this.output === "tools" && req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "required";
      body.parallel_tool_calls = false;
    } else if (this.output === "json" || (this.output === "tools" && !req.tools?.length)) {
      body.response_format = { type: "json_object" };
    }
    if (this.s.stream) { body.stream = true; body.stream_options = { include_usage: true }; }
    return body;
  }

  private async once(req: CompletionRequest): Promise<CompletionResult> {
    const timeout = AbortSignal.timeout(this.s.timeoutMs ?? 90_000);
    const signal = req.signal ? anySignal([req.signal, timeout]) : timeout;
    const direct = this.s.route === "direct";
    const body = this.body(req, req.messages);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw e;
      throw new LLMError(direct ? "Network error (the provider may block browser requests: switch the route to the Worker proxy)" : "Network error reaching the proxy", 0, true);
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        // provider refuses the structured mode: downgrade one level and retry immediately
        if (body.tools && /tool|function/i.test(text)) { this.output = "json"; throw new LLMError("Tool calling unsupported, retrying with JSON mode", -1, true); }
        if (body.response_format && /response_format|json_object|json mode|json_schema|structured/i.test(text)) { this.output = "prompt"; throw new LLMError("JSON mode unsupported, retrying with plain prompting", -1, true); }
      }
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      const hint = res.status === 401 ? " (check the API key)" : res.status === 402 ? " (out of credits)" : res.status === 429 ? " (rate limited)" : "";
      throw new LLMError(`LLM ${res.status}${hint}: ${redact(extractError(text), this.s.apiKey)}`, res.status, retryable, retryAfterMs(res.headers.get("retry-after")));
    }
    const data = body.stream && /event-stream/.test(res.headers.get("content-type") ?? "") ? await this.readStream(res, req) : await this.readJson(res);
    if (data.error) {
      // some providers (OpenRouter) report upstream failures inside a 200
      const code = Number(data.error.code) || 502;
      throw new LLMError(`LLM ${code}: ${redact(String(data.error.message ?? "upstream error"), this.s.apiKey)}`, code, code === 429 || code >= 500);
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    const call = choice?.message?.tool_calls?.[0];
    const text = toolCallToText(content, call);
    if (data.model) this.lastModel = data.model;
    if (!text.trim()) throw new LLMError(`LLM returned an empty reply${choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ""}`, 502, true);
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      usage: {
        prompt: data.usage?.prompt_tokens ?? Math.ceil(promptChars / 4),
        completion: data.usage?.completion_tokens ?? estimateTokens(text),
      },
    };
  }

  private async readJson(res: Response): Promise<ChatResponse> {
    const text = await res.text();
    try {
      return JSON.parse(text) as ChatResponse;
    } catch {
      throw new LLMError("LLM returned non-JSON response", res.status, true);
    }
  }

  /** Reads an SSE stream into one response (content, tool call arguments, usage). */
  private async readStream(res: Response, req: CompletionRequest): Promise<ChatResponse> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", content = "", name = "", args = "", model = "";
    let usage: ChatResponse["usage"];
    let error: ChatResponse["error"];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload) as { model?: string; error?: ChatResponse["error"]; usage?: ChatResponse["usage"]; choices?: { delta?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
          if (j.error) error = j.error;
          if (j.model) model = j.model;
          if (j.usage) usage = j.usage;
          const d = j.choices?.[0]?.delta;
          if (d?.content) { content += d.content; req.onToken?.(d.content); }
          const tc = d?.tool_calls?.[0]?.function;
          if (tc?.name) name += tc.name;
          if (tc?.arguments) args += tc.arguments;
        } catch { /* keep-alive or partial line */ }
      }
    }
    return { model, usage, error, choices: [{ message: { content, tool_calls: name ? [{ function: { name, arguments: args } }] : undefined } }] };
  }
}

function extractError(text: string) {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
    if (m) return String(m).slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300);
}

/** One tiny call to check the endpoint, key and model. Never throws. */
export async function testConnection(s: LLMSettings, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }> {
  const llm = new OpenAICompatibleLLM({ ...s, output: "prompt", stream: false, maxTokens: 16, maxRetries: 0, timeoutMs: s.timeoutMs ?? 30_000 }, fetchImpl);
  const t0 = performance.now();
  try {
    await llm.complete({ agent: "pm", messages: [{ role: "user", content: "Reply with the single word OK." }] });
    return { ok: true, model: llm.lastModel || s.model, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    // reasoning models may spend 8 tokens thinking and return no text: the endpoint, key and model still work
    if (/empty reply/.test((e as Error).message)) return { ok: true, model: llm.lastModel || s.model, latencyMs: Math.round(performance.now() - t0) };
    return { ok: false, model: s.model, latencyMs: Math.round(performance.now() - t0), error: redact((e as Error).message, s.apiKey) };
  }
}

export function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export function costOf(usage: { prompt: number; completion: number }, p: Pricing) {
  return (usage.prompt * p.input + usage.completion * p.output) / 1_000_000;
}
