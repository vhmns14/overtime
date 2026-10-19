// Usage: node scripts/shot.mjs <url> <out.png> <width> <height> [waitMs] [actions]
// actions: comma list of "click:<selector>", "wait:<ms>", "waitfor:<selector>"
import { chromium } from "@playwright/test";
if (process.env.PW_HOME) process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.env.PW_HOME}/.pw-browsers`;
process.env.LD_LIBRARY_PATH = [process.env.PW_HOME && `${process.env.PW_HOME}/.pw-libs`, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
const [url, out, w, h, waitMs = "1500", actions = ""] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? (process.env.PW_HOME ? `${process.env.PW_HOME}/.pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` : undefined) });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1, isMobile: +w < 600, hasTouch: +w < 600 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(+waitMs);
for (const a of actions.split(",").filter(Boolean)) {
  const [k, ...rest] = a.split(":");
  const v = rest.join(":");
  if (k === "click") await page.click(v);
  if (k === "wait") await page.waitForTimeout(+v);
  if (k === "waitfor") await page.waitForSelector(v, { timeout: 90000 });
}
await page.screenshot({ path: out });
console.log("errors:", JSON.stringify(errors));
await browser.close();
