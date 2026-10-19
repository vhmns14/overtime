#!/usr/bin/env node
// Self-host smoke test (what the Docker image runs, without Docker): starts scripts/selfhost.mjs on a
// temporary data directory, creates an office, a building and events, restarts the server, and checks
// that everything is still there. Usage: npm run build && node scripts/selfhost-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.SMOKE_PORT ?? "8798";
const data = process.env.SMOKE_DATA ?? mkdtempSync(join(tmpdir(), "overtime-data-"));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

function start() {
  const child = spawn(process.execPath, [join(root, "scripts/selfhost.mjs")], { cwd: root, env: { ...process.env, PORT: port, HOST: "127.0.0.1", OVERTIME_DATA: data, INSPECTOR_PORT: String(9460 + Math.floor(Math.random() * 30)) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.log = () => log;
  return child;
}
async function up() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(1000);
  }
  return false;
}
async function stop(child) {
  child.kill("SIGTERM");
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(300);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await sleep(800);
}
const json = async (r) => ({ status: r.status, body: await r.json() });

let srv = start();
check(await up(), `server up on ${base} (data in ${data})`);
const o = (await json(await fetch(`${base}/api/ext/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "hermes" }) }))).body;
check(!!o.runId, `office created ${o.runId}`);
const ev = [{ hook_event_name: "on_session_start", session_id: "smoke", extra: { model: "smoke" } }, { hook_event_name: "post_tool_call", tool_name: "skill_manage", tool_input: { action: "create", name: "smoke-skill" }, session_id: "smoke", extra: { status: "ok" } }];
const post = await json(await fetch(`${base}/api/ext/runs/${o.runId}/hermes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.ingestToken}` }, body: JSON.stringify({ batch: ev }) }));
check(post.body.accepted === 3, `2 Hermes envelopes → 3 events accepted (${post.body.accepted})`);
const b = (await json(await fetch(`${base}/api/ext/buildings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Smoke tower" }) }))).body;
const fl = await json(await fetch(`${base}/api/ext/buildings/${b.buildingId}/floors`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${b.adminToken}` }, body: JSON.stringify({ office: o.runId, ingestToken: o.ingestToken }) }));
check(fl.status === 201, `office moved into building ${b.buildingId} as floor ${fl.body.floor}`);
const inst = await fetch(`${base}/hermes-overtime/install.sh`);
check(inst.ok && (await inst.text()).startsWith("#!/bin/sh"), "installer served at /hermes-overtime/install.sh");
const app = await fetch(`${base}/building/${b.buildingId}`);
check(app.ok && /<div id="app"/.test(await app.text()), "app shell served for /building/<id>");

await stop(srv);
srv = start();
check(await up(), "server restarted");
const back = await json(await fetch(`${base}/api/ext/runs/${o.runId}/events?after=0`, { headers: { authorization: `Bearer ${o.viewToken}` } }));
check(back.status === 200 && back.body.events.length === 3, `events persisted across restart (${back.body.events?.length ?? 0}: session.start, tool.end, skill.update)`);
check(back.body.events?.some((e) => e.type === "skill.update" && e.data.name === "smoke-skill"), "skill.update stored with the skill name");
const bb = await json(await fetch(`${base}/api/ext/buildings/${b.buildingId}?v=${b.viewToken}`));
check(bb.status === 200 && bb.body.floors?.[0]?.office === o.runId && bb.body.floors[0].stats?.events === 3, "building and its floor persisted, with live stats");
await stop(srv);
if (!process.env.SMOKE_DATA) rmSync(data, { recursive: true, force: true });
if (failed) { console.log(srv.log().slice(-3000)); process.exit(1); }
console.log("self-host smoke: all good");
