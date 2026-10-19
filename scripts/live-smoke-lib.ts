// Real end-to-end run from the command line, against a real OpenAI-compatible provider and
// (optionally) a real GitHub repo. Every gate is answered automatically and printed; deletions are
// refused; a pull request is only opened when OVERTIME_GH_OPEN_PR=1 (otherwise repo runs are dry).
// The tests drive this same function with a mock provider and the in-memory GitHub.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Orchestrator, DEFAULT_CONFIG } from "../src/engine/orchestrator";
import { OpenAICompatibleLLM, redact, type OutputMode } from "../src/engine/llm";
import { GitHubClient, PatAuth } from "../src/engine/github";
import { repoDeps } from "../src/engine/repo-run";
import type { Pricing, RunStatus, TaskMode } from "../src/engine/types";

export const DEFAULT_SMOKE_TASK = "Build a one-page site for 'Warung Bu Sri', a small rice stall: a short hero, a menu of 4 dishes with prices in Rupiah, opening hours and a contact line. Plain HTML and CSS, no images.";

export interface SmokeEnv { [k: string]: string | undefined }
export interface SmokeDeps {
  llmFetch?: typeof fetch;
  ghFetch?: typeof fetch;
  /** where site output goes (default smoke-out/) */
  outDir?: string;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}
export interface SmokeResult {
  status: RunStatus;
  mode: TaskMode;
  model: string;
  output: string;
  tokens: number;
  usd: number;
  summary: string;
  error: string;
  files: string[];
  pr: { url: string; number: number; branch: string } | null;
  dryRun: boolean;
  invalidReplies: number;
  gates: string[];
  outDir?: string;
}

/** OpenRouter publishes per-token prices; use them so the budget cap is real. */
export async function lookupPricing(base: string, model: string, fetchImpl: typeof fetch): Promise<Pricing | null> {
  if (!/openrouter\.ai/.test(base)) return null;
  try {
    const r = await fetchImpl(base.replace(/\/+$/, "") + "/models");
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
    const m = j.data?.find((x) => x.id === model);
    if (!m?.pricing) return null;
    return { input: Number(m.pricing.prompt ?? 0) * 1e6, output: Number(m.pricing.completion ?? 0) * 1e6 };
  } catch {
    return null;
  }
}

export async function runSmoke(env: SmokeEnv, deps: SmokeDeps = {}): Promise<SmokeResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const baseUrl = env.OVERTIME_LLM_BASE_URL ?? "";
  const model = env.OVERTIME_LLM_MODEL ?? "";
  const key = env.OVERTIME_LLM_KEY ?? "";
  if (!baseUrl || !model) throw new Error("Set OVERTIME_LLM_BASE_URL and OVERTIME_LLM_MODEL (and OVERTIME_LLM_KEY unless the endpoint is local).");
  const say = (l: string) => log(redact(l, key));
  const llmFetch = deps.llmFetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const budgetUsd = Number(env.OVERTIME_BUDGET_USD ?? 0.05);
  let pricing: Pricing = { input: Number(env.OVERTIME_PRICE_IN ?? NaN), output: Number(env.OVERTIME_PRICE_OUT ?? NaN) };
  if (!Number.isFinite(pricing.input) || !Number.isFinite(pricing.output)) {
    pricing = (await lookupPricing(baseUrl, model, llmFetch)) ?? { input: 0, output: 0 };
    if (!pricing.input && !pricing.output && !/:free$|openrouter\/free|localhost|127\.0\.0\.1/.test(model + baseUrl)) say("! no pricing known for this model: the budget cap cannot bite. Set OVERTIME_PRICE_IN / OVERTIME_PRICE_OUT ($ per 1M tokens).");
  }
  const ghToken = env.OVERTIME_GH_TOKEN ?? "";
  const [ghRepo, ghBranchArg] = (env.OVERTIME_GH_REPO ?? "").split("@");
  const mode: TaskMode = ghToken && ghRepo ? "repo" : "site";
  const openPR = env.OVERTIME_GH_OPEN_PR === "1";
  const task = env.OVERTIME_TASK?.trim() || (mode === "site" ? DEFAULT_SMOKE_TASK : "");
  if (!task) throw new Error("Set OVERTIME_TASK: what should change in the repo?");

  const llm = new OpenAICompatibleLLM({
    baseUrl, model, apiKey: key, route: "direct", jsonMode: true,
    output: (env.OVERTIME_LLM_OUTPUT as OutputMode) || "auto",
    timeoutMs: Number(env.OVERTIME_LLM_TIMEOUT_MS ?? 120_000),
    sleep: deps.sleep,
    onRetry: (r) => say(`  … retry ${r.attempt} in ${(r.waitMs / 1000).toFixed(1)} s (${r.status || "network"}: ${r.reason})`),
  }, llmFetch);

  let hooks = {};
  let branch = ghBranchArg ?? "";
  if (mode === "repo") {
    const gh = new GitHubClient(new PatAuth(ghToken), { route: "direct", fetchImpl: deps.ghFetch });
    if (!branch) branch = (await gh.getRepo(ghRepo)).default_branch;
    hooks = repoDeps(gh, { repo: ghRepo, branch }, { dryRun: !openPR });
    say(`repo mode: ${ghRepo} @ ${branch}${openPR ? " (WILL open a PR)" : " (dry run: no branch, no PR)"}`);
  }

  const runId = `smoke-${Date.now().toString(36)}`;
  const gates: string[] = [];
  let invalidReplies = 0;
  const o = new Orchestrator({
    llm, runId, modelLabel: model,
    config: { ...DEFAULT_CONFIG, task, mode, repo: mode === "repo" ? { repo: ghRepo, branch } : undefined, budgetUsd, pricing, maxStepsPerAgent: Number(env.OVERTIME_MAX_STEPS ?? 12) },
    deploy: async () => ({ url: "", local: true }),
    ...hooks,
  });
  const t0 = Date.now();
  o.on((e) => {
    if (e.type === "log") {
      const sec = ((e.entry.t - t0) / 1000).toFixed(0).padStart(3);
      if (/invalid reply/.test(e.entry.text)) invalidReplies++;
      say(`[${sec}s] ${e.entry.agent.padEnd(8)} ${e.entry.level === "info" ? "" : e.entry.level!.toUpperCase() + " "}${e.entry.text}`);
    }
    if (e.type === "gate") {
      const g = e.gate;
      const action = g.kind === "delete" ? "reject" : "approve";
      gates.push(`${g.kind}:${action}`);
      say(`  ▸ gate (${g.kind}) ${g.title} → auto-${action}`);
      for (const i of (g.items ?? []).slice(0, 8)) say(`      ${i}`);
      queueMicrotask(() => o.decide(g.id, { action }));
    }
    if (e.type === "cost") return;
  });
  say(`model ${model} @ ${new URL(baseUrl).host} · ${mode} · budget $${budgetUsd} · pricing in $${pricing.input}/M out $${pricing.output}/M`);
  const status = await o.run();
  let outDir: string | undefined;
  if (mode === "site" && Object.keys(o.files).length) {
    outDir = join(deps.outDir ?? "smoke-out", runId);
    for (const [p, c] of Object.entries(o.files)) {
      const f = join(outDir, p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, c);
    }
  }
  if (mode === "repo" && o.repo) for (const c of o.repo.changes()) say(o.repo.diff(c.path));
  const result: SmokeResult = {
    status, mode, model, output: llm.output, tokens: o.usage.tokens, usd: o.usage.usd, summary: o.summary, error: redact(o.error, key),
    files: Object.keys(o.files).sort(), pr: o.pr, dryRun: mode === "repo" && !openPR, invalidReplies, gates, outDir,
  };
  say(`\n${status.toUpperCase()} · ${result.tokens.toLocaleString("en-US")} tokens · $${result.usd.toFixed(4)} · reply format ${result.output} · ${invalidReplies} invalid repl${invalidReplies === 1 ? "y" : "ies"}${result.error ? ` · ${result.error}` : ""}`);
  if (outDir) say(`site written to ${outDir}/ (${result.files.length} files)`);
  if (result.pr) say(`PR: ${result.pr.url}`);
  return result;
}
