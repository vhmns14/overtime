// Screenshots of a live office while a real Hermes runs: node scripts/watch-shots.mjs <office.json> <outPrefix> <w> <h> <ms,ms,...>
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
if (process.env.PW_HOME) process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.env.PW_HOME}/.pw-browsers`;
const [officeFile, prefix, w, h, times, base = "http://127.0.0.1:8787"] = process.argv.slice(2);
const o = JSON.parse(readFileSync(officeFile, "utf8"));
const creds = { runId: o.runId, ingestToken: o.ingestToken, viewToken: o.viewToken, webhookSecret: o.webhookSecret, privacy: o.privacy, createdAt: Date.now(), origin: base };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? (process.env.PW_HOME ? `${process.env.PW_HOME}/.pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` : undefined) });
const mobile = +w < 600;
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript((c) => { localStorage.setItem("overtime:hermes-office:v1", JSON.stringify(c)); }, creds);
await page.goto(`${base}/?target=hermes`);
const t0 = Date.now();
for (const [i, t] of times.split(",").map(Number).entries()) {
  await page.waitForTimeout(Math.max(0, t - (Date.now() - t0)));
  await page.screenshot({ path: `${prefix}-${i + 1}.png` });
}
console.log("errors:", JSON.stringify(errors));
await browser.close();
