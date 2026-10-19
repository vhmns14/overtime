// Frames of the recorded Hermes demo for docs: node scripts/hermes-shots.mjs <outPrefix> <w> <h> <ms,ms,...> [speed]
import { chromium } from "@playwright/test";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/workspace/work/.pw-browsers";
const [prefix, w, h, times, speed = "0.5", base = "http://127.0.0.1:8787"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/workspace/work/.pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const mobile = +w < 600;
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?target=demo-hermes&speed=${speed}`);
await page.waitForSelector('#hermes-box [data-hx="play"]');
await page.click('#hermes-box [data-hx="play"]');
const t0 = Date.now();
for (const [i, t] of times.split(",").map(Number).entries()) {
  await page.waitForTimeout(Math.max(0, t - (Date.now() - t0)));
  await page.screenshot({ path: `${prefix}-${i + 1}.png` });
}
console.log("errors:", JSON.stringify(errors));
await browser.close();
