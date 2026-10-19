#!/usr/bin/env node
// Runs Overtime fully self-contained: the same Worker and SQLite Durable Objects as on Cloudflare,
// served by workerd (Cloudflare's open-source Workers runtime) through `wrangler dev --local`, with
// every office, building and preview persisted under OVERTIME_DATA. No Cloudflare account, no network
// needed. This is the Docker image's entrypoint; it also runs as-is on any machine with Node 20+.
//
//   OVERTIME_DATA=/data   where the SQLite state lives (mount a volume here)
//   PORT=8787  HOST=0.0.0.0
//   EXT_TTL_DAYS=30  PREVIEW_TTL_DAYS=7   (optional overrides of wrangler.toml [vars])
//   remote control (optional): PUBLIC_URL, OVERTIME_SECRET_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OVERTIME_TELEGRAM_OFFICES (see docs/SELF_HOST.md)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const PASS = ["EXT_TTL_DAYS", "PREVIEW_TTL_DAYS", "PUBLIC_URL", "OVERTIME_SECRET_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "OVERTIME_TELEGRAM_OFFICES"];
// settings (some of them secrets) go to the Worker through a private env file, never on the command
// line: argv is readable by every user and container on the host (ps, /proc/<pid>/cmdline)
const varsDir = mkdtempSync(resolve(tmpdir(), "overtime-vars-"));
const varsFile = resolve(varsDir, "vars.env");
const quote = (v) => JSON.stringify(String(v));
writeFileSync(varsFile, PASS.filter((k) => process.env[k]).map((k) => `${k}=${quote(process.env[k])}\n`).join(""), { mode: 0o600 });
const vars = ["--env-file", varsFile];
const cleanup = () => { try { rmSync(varsDir, { recursive: true, force: true }); } catch { /* gone */ } };
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const args = [wrangler, "dev", "--local", "--ip", host, "--port", port, "--persist-to", data, "--show-interactive-dev-session=false", "--log-level", process.env.LOG_LEVEL ?? "warn", "--inspector-ip", "127.0.0.1", "--inspector-port", process.env.INSPECTOR_PORT ?? "0", ...vars];
console.log(`overtime: serving on http://${host}:${port} · data in ${data}`);
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_UPDATE_NOTIFIER: "1", CI: process.env.CI ?? "1" };
for (const k of PASS) delete childEnv[k]; // the Worker reads them from the env file only
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: childEnv });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, sig) => { cleanup(); process.exit(code ?? (sig ? 0 : 1)); });
