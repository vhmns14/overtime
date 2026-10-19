import { PRESETS, OpenAICompatibleLLM, type LLMSettings, type OutputMode } from "../engine/llm";
import { store, secretStore } from "../engine/storage";
import type { Gates, LLM, TaskMode } from "../engine/types";
import { DemoLLM, type DemoId } from "../demo/demo-llm";
import { GitHubClient, PatAuth, type AuthProvider } from "../engine/github";
import { DEMO_GH_TOKEN, demoGitHub } from "../demo/demo-repo";

export type Surface = "hermes" | "demo-hermes" | "team";

export interface Settings {
  /** what the office shows: your Hermes agent (default), the recorded Hermes demo, or the built-in team */
  surface: Surface;
  mode: "demo" | "live";
  preset: string;
  baseUrl: string;
  model: string;
  route: "proxy" | "direct";
  jsonMode: boolean;
  output: OutputMode;
  stream: boolean;
  rememberKey: boolean;
  priceIn: number;
  priceOut: number;
  budgetUsd: number;
  gates: Gates;
  demoSpeed: number;
  /** which recorded demo runs in demo mode */
  demo: DemoId;
  /** live mode: build a new site, or work on a GitHub repo */
  taskKind: TaskMode;
  ghRepo: string;
  ghBranch: string;
  ghLogin: string;
  ghRemember: boolean;
  ghRoute: "proxy" | "direct";
}

const KEY = "overtime:settings:v1";
const SECRET_KEY = "overtime:llm-key";
const SECRET_GH = "overtime:gh-token";

export function defaults(): Settings {
  const p = PRESETS[0];
  return {
    surface: __PREVIEW__ ? "demo-hermes" : "hermes",
    mode: "demo", preset: p.id, baseUrl: p.baseUrl, model: p.model, route: p.route, jsonMode: true, output: "auto", stream: false, rememberKey: false,
    priceIn: p.pricing.input, priceOut: p.pricing.output, budgetUsd: 0.5, gates: { plan: true, review: true, deploy: true },
    demoSpeed: 1, demo: "kopi-senja", taskKind: "site", ghRepo: "", ghBranch: "", ghLogin: "", ghRemember: false, ghRoute: "proxy",
  };
}

export function loadSettings(): Settings {
  const s = { ...defaults(), ...store.getJSON<Partial<Settings>>(KEY, {}) };
  s.gates = { ...defaults().gates, ...(s.gates ?? {}) };
  return s;
}
export function saveSettings(s: Settings) { store.setJSON(KEY, s); }

export const secrets = {
  apiKey: (s: Settings) => secretStore.get(SECRET_KEY, s.rememberKey),
  setApiKey: (s: Settings, v: string) => (v ? secretStore.set(SECRET_KEY, v, s.rememberKey) : secretStore.clear(SECRET_KEY)),
  ghToken: (s: Settings) => secretStore.get(SECRET_GH, s.ghRemember),
  setGhToken: (s: Settings, v: string) => (v ? secretStore.set(SECRET_GH, v, s.ghRemember) : secretStore.clear(SECRET_GH)),
};

export function llmSettings(s: Settings, extra: Partial<LLMSettings> = {}): LLMSettings {
  return { baseUrl: s.baseUrl, model: s.model, apiKey: secrets.apiKey(s), route: s.route, jsonMode: s.jsonMode, output: s.output, stream: s.stream, ...extra };
}

export function buildLLM(s: Settings, speedOverride?: number, extra: Partial<LLMSettings> = {}): LLM {
  if (s.mode === "demo") return new DemoLLM({ speed: speedOverride ?? s.demoSpeed, script: s.demo === "repo-fix" ? "repo" : "site" });
  return new OpenAICompatibleLLM(llmSettings(s, extra));
}

/** The auth provider for GitHub. Only PATs today; an OAuth/GitHub App provider plugs in here. */
export function githubAuth(s: Settings): AuthProvider {
  return new PatAuth(secrets.ghToken(s));
}

/** Demo mode talks to an in-memory GitHub; live mode to the real API through the Worker proxy. */
export function buildGitHub(s: Settings, opts: { demoLatencyMs?: number; token?: string } = {}): GitHubClient {
  if (s.mode === "demo") return new GitHubClient(new PatAuth(DEMO_GH_TOKEN), { fetchImpl: demoGitHub(opts.demoLatencyMs ?? 0).fetch });
  return new GitHubClient(opts.token !== undefined ? new PatAuth(opts.token) : githubAuth(s), { route: s.ghRoute });
}
