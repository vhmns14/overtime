// USD per 1M tokens for models people commonly run Hermes on. Used only when an llm.call event has
// no cost_usd (the hermes-overtime plugin sends Hermes' own estimate when Hermes knows the price).
// Unknown models count tokens and show "price unknown" instead of guessing.

export interface Price { input: number; output: number; cacheRead?: number }

const TABLE: [RegExp, Price][] = [
  [/gpt-4o-mini/i, { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  [/gpt-4o(?!-mini)/i, { input: 2.5, output: 10, cacheRead: 1.25 }],
  [/gpt-4\.1-mini/i, { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  [/gpt-4\.1-nano/i, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
  [/gpt-4\.1(?![-\w])/i, { input: 2, output: 8, cacheRead: 0.5 }],
  [/claude-(3[.-]5-|3[.-]7-)?sonnet|claude-sonnet-4/i, { input: 3, output: 15, cacheRead: 0.3 }],
  [/claude-(3[.-]5-)?haiku-?3?|claude-3-haiku/i, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/claude-haiku-4/i, { input: 1, output: 5, cacheRead: 0.1 }],
  [/claude-opus-4[.-][15]/i, { input: 5, output: 25, cacheRead: 0.5 }],
  [/claude-(3-)?opus/i, { input: 15, output: 75, cacheRead: 1.5 }],
  [/gemini-2\.5-flash/i, { input: 0.3, output: 2.5, cacheRead: 0.075 }],
  [/gemini-2\.5-pro/i, { input: 1.25, output: 10, cacheRead: 0.31 }],
  [/deepseek-chat|deepseek-v3/i, { input: 0.27, output: 1.1, cacheRead: 0.07 }],
];

export function priceFor(model: string | undefined): Price | null {
  if (!model) return null;
  if (/:free$|\/free$/i.test(model)) return { input: 0, output: 0 };
  for (const [re, p] of TABLE) if (re.test(model)) return p;
  return null;
}

export function costOf(model: string | undefined, input = 0, output = 0, cacheRead = 0, fallback?: Price | null): number | null {
  const p = priceFor(model) ?? fallback ?? null;
  if (!p) return null;
  return (input * p.input + output * p.output + cacheRead * (p.cacheRead ?? p.input)) / 1e6;
}
