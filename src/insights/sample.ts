// Demo only: two weeks of sample model calls so the cost dashboard has something to show next to the
// recorded session. Deterministic (seeded) and always labelled "sample" in the UI. Never used for a
// real office.

import type { ExtEvent } from "../ext/schema";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const MODELS = ["anthropic/claude-sonnet-4", "openai/gpt-4o-mini", "deepseek/deepseek-chat"];
const TITLES = ["Nightly dependency check", "Telegram: summarize the team chat", "Fix flaky test in billing", "Cron: rotate logs and report disk", "Refactor the auth middleware", "Research: Postgres connection pooling", "Draft the release notes"];

/** Sample sessions for the `days - 1` days before `now` (the recorded demo fills today). */
export function sampleHistory(now: number, days = 14): ExtEvent[] {
  const r = rng(1910);
  const out: ExtEvent[] = [];
  let seq = -1_000_000;
  for (let d = days - 1; d >= 1; d--) {
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const start = now - d * 86_400_000 + Math.floor(r() * 8) * 3_600_000 - 4 * 3_600_000;
      const session = `sample-${d}-${k}`;
      const model = MODELS[Math.floor(r() * (r() < 0.25 ? 3 : 2))];
      out.push({ v: 1, seq: seq++, type: "session.start", ts: start, session, agent: "main", data: { title: `Sample · ${TITLES[Math.floor(r() * TITLES.length)]}`, model, platform: k % 2 ? "telegram" : "cli" } });
      const calls = 3 + Math.floor(r() * 14);
      for (let c = 0; c < calls; c++) {
        const input = 2000 + Math.floor(r() * 9000), output = 80 + Math.floor(r() * 900), cache = Math.floor(r() * input * 2);
        out.push({ v: 1, seq: seq++, type: "llm.call", ts: start + c * 9000, session, agent: "main", data: { model, input_tokens: input, output_tokens: output, cache_read_tokens: cache } });
      }
      out.push({ v: 1, seq: seq++, type: "session.end", ts: start + calls * 9000 + 2000, session, agent: "main", data: { status: "completed" } });
    }
  }
  return out;
}
