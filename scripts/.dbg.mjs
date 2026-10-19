import { chromium } from "@playwright/test";
process.env.LD_LIBRARY_PATH = "/workspace/work/.pw-libs";
const browser = await chromium.launch({ executablePath: "/workspace/work/.pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log("console:", m.type(), m.text()));
page.on("pageerror", (e) => console.log("pageerror", String(e)));
await page.goto("http://127.0.0.1:8787/?speed=0.35");
await page.waitForTimeout(1000);
await page.click("#run-btn");
await page.waitForSelector("#approval:not([hidden])");
await page.click("#approval [data-act=approve]");
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(2000);
  console.log(await page.evaluate(() => { const a = window.__overtime; const o = a.orch; const off = a.office; return JSON.stringify({ st: o.status, steps: o.steps, actors: Object.values(off.actors).map(x => [x.role, x.mode, Math.round(x.x), Math.round(x.y), x.path.length, x.busy]) }); }));
}
await browser.close();
