#!/usr/bin/env node
// Runs Overtime fully self-contained: the same Worker and SQLite Durable Objects as on Cloudflare,
// served by workerd (Cloudflare's open-source Workers runtime) through `wrangler dev --local`, with
// every office, building and preview persisted under OVERTIME_DATA. No Cloudflare account, no network
// needed. This is the Docker image's entrypoint; it also runs as-is on any machine with Node 20+.
//
//   OVERTIME_DATA=/data   where the SQLite state lives (mount a volume here)
//   PORT=8787  HOST=0.0.0.0
//   EXT_TTL_DAYS=30  PREVIEW_TTL_DAYS=7   (optional overrides of wrangler.toml [vars])
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(process.env.OVERTIME_DATA ?? resolve(root, ".overtime-data"));
const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";
mkdirSync(data, { recursive: true });
if (!existsSync(resolve(root, "dist/index.html"))) {
  console.error("overtime: dist/ is missing. Run `npm run build` first (the Docker image does this for you).");
  process.exit(1);
}
const vars = [];
for (const k of ["EXT_TTL_DAYS", "PREVIEW_TTL_DAYS"]) if (process.env[k]) vars.push("--var", `${k}:${process.env[k]}`);
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const args = [wrangler, "dev", "--local", "--ip", host, "--port", port, "--persist-to", data, "--show-interactive-dev-session=false", "--log-level", process.env.LOG_LEVEL ?? "warn", "--inspector-port", process.env.INSPECTOR_PORT ?? "0", ...vars];
console.log(`overtime: serving on http://${host}:${port} · data in ${data}`);
const child = spawn(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_UPDATE_NOTIFIER: "1", CI: process.env.CI ?? "1" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 0 : 1)));
