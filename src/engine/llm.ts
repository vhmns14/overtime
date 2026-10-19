// Bring-your-own-key client for any OpenAI-compatible /chat/completions endpoint.
// The key lives in the browser; each request carries it either straight to the provider (when the
// provider allows CORS) or through the Worker's stateless /api/llm proxy, which never stores or logs it.

import type { CompletionRequest, CompletionResult, LLM, Pricing } from "./types";

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  pricing: Pricing;
  /** request route that works out of the box for this provider */
  route: "proxy" | "direct";
}

export const PRESETS: Preset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", pricing: { input: 0.15, output: 0.6 }, route: "proxy" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", pricing: { input: 0.15, output: 0.6 }, route: "direct" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", pricing: { input: 0.59, output: 0.79 }, route: "proxy" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", pricing: { input: 0, output: 0 }, route: "direct" },
];

export interface LLMSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  route: "proxy" | "direct";
  jsonMode: boolean;
  timeoutMs?: number;
  /** where the proxy lives (same origin by default) */
  proxyUrl?: string;
}

export class LLMError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = false) {
    super(message);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
  });

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Scrubs anything that looks like a credential before an error reaches the log. */
export function redact(s: string, secret?: string) {
  let out = s;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/(sk|gsk|or|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export class OpenAICompatibleLLM implements LLM {
  readonly label: string;
  private jsonMode: boolean;
  constructor(private s: LLMSettings, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.label = `${s.model} @ ${new URL(s.baseUrl).host}`;
    this.jsonMode = s.jsonMode;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.once(req);
      } catch (e) {
        lastErr = e;
        if ((e as Error).name === "AbortError" && req.signal?.aborted) throw e;
        const retryable = e instanceof LLMError ? e.retryable : (e as Error).name === "TimeoutError" || e instanceof TypeError;
        if (!retryable || attempt === 2) break;
        await sleep(800 * 3 ** attempt, req.signal);
      }
    }
    throw lastErr;
  }

  private async once(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = { model: this.s.model, messages: req.messages, temperature: 0.2, max_tokens: 4096 };
    if (this.jsonMode) body.response_format = { type: "json_object" };
    const timeout = AbortSignal.timeout(this.s.timeoutMs ?? 90_000);
    const signal = req.signal ? anySignal([req.signal, timeout]) : timeout;
    const direct = this.s.route === "direct";
    const url = direct ? this.s.baseUrl.replace(/\/+$/, "") + "/chat/completions" : (this.s.proxyUrl ?? "/api/llm");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.s.apiKey) headers.authorization = `Bearer ${this.s.apiKey}`;
    if (!direct) headers["x-ot-base-url"] = this.s.baseUrl;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw e;
      throw new LLMError(direct ? "Network error (the provider may block browser requests: switch the route to the Worker proxy)" : "Network error reaching the proxy", 0, true);
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 400 && this.jsonMode && /response_format|json_object|json mode/i.test(text)) {
        this.jsonMode = false; // provider does not support JSON mode: fall back to prompt-only JSON
        throw new LLMError("JSON mode unsupported, retrying without it", 400, true);
      }
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMError(`LLM ${res.status}: ${redact(text.slice(0, 300), this.s.apiKey)}`, res.status, retryable);
    }
    let data: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      data = JSON.parse(text);
    } catch {
      throw new LLMError("LLM returned non-JSON response", res.status, true);
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text: content,
      usage: {
        prompt: data.usage?.prompt_tokens ?? Math.ceil(promptChars / 4),
        completion: data.usage?.completion_tokens ?? estimateTokens(content),
      },
    };
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
