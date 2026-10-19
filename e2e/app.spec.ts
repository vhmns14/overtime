import { test, expect } from "@playwright/test";
import { trackErrors, openApp, waitGate, decide, runDemoToEnd, isMobile, gateSel } from "./helpers";

test("demo run: start → approve every gate → live preview served by the Worker", async ({ page, request }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await runDemoToEnd(page);
  await expect(page.locator("#result")).toContainText("Preview is live");
  await expect(page.locator("#result")).toContainText("all checks pass");
  await expect(page.locator("#mode-chip")).toContainText("done");
  // step tracker all done
  const pips = isMobile(page) ? page.locator("#steps-h li.done") : page.locator("#steps li.done");
  await expect(pips).toHaveCount(5);
  // preview iframe served from /p/<runId>/ with the site inside
  await page.locator('#result [data-r="preview"]').click();
  const iframe = page.locator("#files iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  const src = await iframe.getAttribute("src");
  expect(src).toMatch(/^\/p\/run-[a-z0-9]+-[a-z0-9]{4}\/$/);
  await expect(page.frameLocator("#files iframe").locator("h1")).toHaveText("Coffee for the hour the sky turns orange.");
  // the stylesheet really loaded (dark hero) -> the fix round worked end to end
  const heroBg = await page.frameLocator("#files iframe").locator(".hero").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(heroBg).toBe("rgb(61, 36, 24)");
  // locked-down headers on the preview path
  const res = await request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-security-policy"]).toContain("sandbox allow-scripts allow-forms");
  expect(res.headers()["content-security-policy"]).toContain("connect-src 'none'");
  expect((await request.get(src! + "css/style.css")).status()).toBe(200);
  expect((await request.get(src! + "%2e%2e%2f%2e%2e%2fsecret.html")).status()).toBe(404);
  expect((await request.get(src! + "nope.html")).status()).toBe(404);
  // cost meter moved and has a per-agent breakdown
  await page.locator("#files [data-close]").click();
  await expect(page.locator("#cost-usd")).not.toHaveText("$0.00");
  await page.locator("#cost").click();
  await expect(page.locator("#cost-break")).toContainText("Coder");
  expect(errors).toEqual([]);
});

test("files view: tree, versions and the Coder v1 → v2 diff", async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await runDemoToEnd(page);
  await page.locator('#result [data-r="files"]').click();
  const files = page.locator("#files");
  await expect(files.locator(".tree")).toContainText("index.html");
  await expect(files.locator(".tree")).toContainText("style.css");
  await expect(files.locator(".tree")).toContainText("brief.md");
  await expect(files.locator("[data-version] option")).toHaveText(["Latest", "Coder v1", "Coder v2 (fix round 1)"]);
  await files.locator("[data-diff]").check();
  await expect(files.locator(".ln.del")).toHaveCount(2);
  await expect(files.locator(".ln.add")).toHaveCount(2);
  await expect(files.locator(".ln.del").first()).toContainText('href="css/styles.css"');
  await expect(files.locator(".ln.add").first()).toContainText('href="css/style.css"');
  await expect(files.locator(".ln.add").nth(1)).toContainText('alt="A glass of iced palm-sugar coffee');
  // older version, other file
  await files.locator("[data-version]").selectOption({ label: "Coder v1" });
  await expect(files.locator("[data-code]")).toContainText("css/styles.css");
  await files.locator('.tree [data-path="js/main.js"]').click();
  await expect(files.locator("[data-code]")).toContainText("Kopi Senja: mobile nav");
  expect(errors).toEqual([]);
});

test("cancel stops the run while it waits for approval", async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.locator("#run-btn").click();
  await waitGate(page, /PM wants to start/);
  if (isMobile(page)) {
    // the full-screen approval covers the sheet on phones: reject with a comment, then cancel mid-run
    await decide(page, "reject", "Fewer tickets please");
    await waitGate(page, /PM wants to start/);
    await page.locator('#mobile-approval [data-act="cancel-run"]').click();
  } else {
    await page.locator("#cancel-btn").click();
  }
  await expect(page.locator("#mode-chip")).toContainText("cancelled");
  await expect(page.locator("#log")).toContainText("Run cancelled");
  await expect(page.locator(gateSel(page))).toBeHidden();
  await expect(page.locator("#run-btn")).toBeVisible();
  expect(errors).toEqual([]);
});

test("reject with a comment sends feedback and the PM re-plans", async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.locator("#run-btn").click();
  await waitGate(page, /PM wants to start/);
  await decide(page, "reject", "Keep it to one page");
  await expect(page.locator("#log")).toContainText("You rejected: PM wants to start with 6 tickets");
  await waitGate(page, /PM wants to start/);
  await expect(page.locator("#log")).toContainText("Reworked the plan around your note");
  await decide(page, "approve");
  await expect(page.locator("#log")).toContainText("Writing the brief", { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("clicking an agent shows their thought, log and files", async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await runDemoToEnd(page);
  if (isMobile(page)) await page.locator("#office").scrollIntoViewIfNeeded();
  await page.locator('.actor[data-role="coder"] .tag').click({ force: true });
  const card = page.locator("#agent-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Coder");
  await expect(card).toContainText("index.html");
  await expect(card).toContainText("tokens");
  await card.locator('[data-f="css/style.css"]').click();
  await expect(page.locator("#files .viewer-bar")).toContainText("css/style.css");
  expect(errors).toEqual([]);
});

test("live mode without a key asks for one instead of calling anything", async ({ page }) => {
  const errors = trackErrors(page);
  const llmCalls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/llm") || r.url().includes("openai.com")) llmCalls.push(r.url()); });
  await openApp(page);
  await page.locator(isMobile(page) ? '.mobile-bar [data-open="settings"]' : '.panel-nav [data-open="settings"]').click();
  await page.locator('[data-mode="live"]').click();
  await page.locator("#settings-form").evaluate((f: HTMLFormElement) => f.requestSubmit());
  await expect(page.locator("#task-mode")).toContainText("Live");
  await page.locator("#task").fill("Build a pricing page for a bakery");
  await page.locator("#run-btn").click();
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator('input[name="apiKey"]')).toHaveAttribute("type", "password");
  expect(llmCalls).toEqual([]);
  expect(errors).toEqual([]);
});
