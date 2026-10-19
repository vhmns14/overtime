import { PRESETS, OpenAICompatibleLLM } from "../engine/llm";
import { store, secretStore } from "../engine/storage";
import type { Gates, LLM } from "../engine/types";
import { DemoLLM } from "../demo/demo-llm";

export interface Settings {
  mode: "demo" | "live";
  preset: string;
  baseUrl: string;
  model: string;
  route: "proxy" | "direct";
  jsonMode: boolean;
  rememberKey: boolean;
  priceIn: number;
  priceOut: number;
  budgetUsd: number;
  gates: Gates;
  demoSpeed: number;
  ghRepo: string;
  ghBranch: string;
}

const KEY = "overtime:settings:v1";
const SECRET_KEY = "overtime:llm-key";
const SECRET_GH = "overtime:gh-token";

export function defaults(): Settings {
  const p = PRESETS[0];
  return {
    mode: "demo", preset: p.id, baseUrl: p.baseUrl, model: p.model, route: p.route, jsonMode: true, rememberKey: false,
    priceIn: p.pricing.input, priceOut: p.pricing.output, budgetUsd: 0.5, gates: { plan: true, review: true, deploy: true },
    demoSpeed: 1, ghRepo: "", ghBranch: "overtime-preview",
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
  ghToken: () => secretStore.get(SECRET_GH, false),
  setGhToken: (v: string) => (v ? secretStore.set(SECRET_GH, v, false) : secretStore.clear(SECRET_GH)),
};

export function buildLLM(s: Settings, speedOverride?: number): LLM {
  if (s.mode === "demo") return new DemoLLM({ speed: speedOverride ?? s.demoSpeed });
  return new OpenAICompatibleLLM({ baseUrl: s.baseUrl, model: s.model, apiKey: secrets.apiKey(s), route: s.route, jsonMode: s.jsonMode });
}
