// npm run live:smoke — a real end-to-end run. See scripts/live-smoke-lib.ts and the README.
//   OVERTIME_LLM_BASE_URL  e.g. https://openrouter.ai/api/v1
//   OVERTIME_LLM_KEY       your provider key (never printed)
//   OVERTIME_LLM_MODEL     e.g. openai/gpt-4o-mini or openrouter/free
//   OVERTIME_BUDGET_USD    hard cap per run (default 0.05)
//   OVERTIME_TASK          optional task text
//   OVERTIME_GH_TOKEN + OVERTIME_GH_REPO=owner/name[@branch]  → repo mode (dry run)
//   OVERTIME_GH_OPEN_PR=1  → actually create the branch + PR
import { runSmoke } from "./live-smoke-lib";

runSmoke(process.env)
  .then((r) => { process.exitCode = r.status === "done" ? 0 : 1; })
  .catch((e) => { console.error(`smoke failed: ${(e as Error).message}`); process.exitCode = 2; });
