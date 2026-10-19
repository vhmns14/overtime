import { test, expect, type Page } from "@playwright/test";
import { trackErrors, openApp, waitGate, decide, isMobile } from "./helpers";
import { FakeGitHub } from "../src/demo/fake-github";

const shot = (page: Page, name: string) => page.screenshot({ path: `shots/${isMobile(page) ? "mobile" : "desktop"}-${name}.png` });
const TOKEN = "github_pat_11E2ETEST0000_abcdefghijklmnopqrstuvwxyz0123";

test("PR demo: fix a bug in a repo → reviewer catch → pull request opened", async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.locator("#task-kind").selectOption("repo-fix");
  await expect(page.locator("#task")).toHaveValue("Fix: cart total ignores item quantity (issue #7)");
  await expect(page.locator("#repo-btn")).toContainText("kodekecil/warung-cart @ main · demo");
  await page.locator("#run-btn").click();
  const plan = await waitGate(page, /PM wants to start with 5 tickets on kodekecil\/warung-cart/);
  if (!isMobile(page)) {
    await plan.locator("details summary").click();
    await expect(plan).toContainText("file · src/cart.mjs");
  }
  await decide(page, "approve");
  await waitGate(page, /Reviewer: 1 check failing, fix before the PR\?/);
  await decide(page, "approve");
  const pr = await waitGate(page, /Ops wants to open a PR on kodekecil\/warung-cart \(2 files\)/);
  await expect(pr.locator('[data-act="approve"]')).toHaveText("Open PR");
  await expect(pr.locator(".diff")).toContainText("return item.price * (item.qty ?? 1);");
  await shot(page, "repo-pr-gate");
  await decide(page, "approve");
  const result = page.locator("#result");
  await expect(result).toContainText("Pull request #8 is open", { timeout: 60_000 });
  await expect(result).toContainText(/overtime\/fix-cart-subtotal-ignoring-item-[a-z0-9]{6} → main/);
  await expect(result.locator('[data-r="pr"]')).toHaveAttribute("href", "https://github.com/kodekecil/warung-cart/pull/8");
  await expect(page.locator(isMobile(page) ? "#steps-h li.done" : "#steps li.done")).toHaveCount(5);
  if (!isMobile(page)) await expect(page.locator("#steps")).toContainText("Open PR");
  await page.waitForTimeout(900); // Ops celebrates at the whiteboard
  await result.scrollIntoViewIfNeeded();
  await shot(page, "repo-pr-opened");
  // per-file unified diff vs base
  await result.locator('[data-r="changes"]').click();
  const files = page.locator("#files");
  await expect(files.locator('[data-tab="changes"]')).toHaveAttribute("aria-selected", "true");
  await expect(files.locator(".tree")).toContainText("2 changed · +5 −1");
  await expect(files.locator("[data-diff-view] .ln.hunk").first()).toHaveText("@@ -2,7 +2,7 @@");
  await expect(files.locator("[data-diff-view] .ln.add")).toHaveText(["  return item.price * (item.qty ?? 1);"]);
  await expect(files.locator("[data-diff-view] .ln.del")).toHaveText(["  return item.price;"]);
  await files.locator('[data-change="test/cart.test.mjs"]').click();
  await expect(files.locator("[data-diff-view]")).toContainText("issue #7");
  await files.locator('[data-change="src/cart.mjs"]').click();
  await shot(page, "repo-diff");
  await files.locator("[data-close]").click();
  expect(errors).toEqual([]);
});

test("connect GitHub with a PAT (mocked API): bad token → clear error, good token → repos, branch, chip", async ({ page }) => {
  const errors = trackErrors(page);
  const fake = new FakeGitHub(TOKEN, "octo-dev", [
    { full_name: "octo-dev/shop", description: "Online shop", files: { "README.md": "# shop\n" }, protectedBranches: ["main"], extraBranches: ["develop"] },
    { full_name: "octo-dev/blog", files: { "index.md": "hi\n" } },
  ]);
  const seen: { url: string; token: string | null; auth: string | null }[] = [];
  await page.route("**/api/gh/**", async (route) => {
    const req = route.request();
    seen.push({ url: req.url(), token: req.headers()["x-ot-gh-token"] ?? null, auth: req.headers()["authorization"] ?? null });
    const res = await fake.fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem("overtime:settings:v1")) localStorage.setItem("overtime:settings:v1", JSON.stringify({ surface: "team", mode: "live", taskKind: "repo" }));
  });
  await openApp(page, 0.2, null);
  await expect(page.locator("#task-kind")).toHaveValue("repo");
  await expect(page.locator("#repo-btn")).toHaveText("Connect GitHub…");
  await page.locator("#repo-btn").click();
  const gh = page.locator("#github");
  await expect(gh).toBeVisible();
  await expect(gh).toContainText("Contents: Read and write");
  await expect(gh).toContainText("Pull requests: Read and write");
  await gh.locator('[name="gh-token"]').fill("github_pat_wrong_000000000000000000000");
  await gh.locator("[data-connect]").click();
  await expect(gh.locator(".err")).toContainText("GitHub rejected the token (401)");
  await gh.locator('[name="gh-token"]').fill(TOKEN);
  await gh.locator("[data-connect]").click();
  await expect(gh.locator(".who")).toContainText("@octo-dev");
  await expect(gh.locator("[data-repo]")).toHaveCount(2);
  await gh.locator('[name="gh-filter"]').fill("sho");
  await expect(gh.locator("[data-repo]")).toHaveCount(1);
  await gh.locator('[data-repo="octo-dev/shop"]').click();
  await expect(gh.locator('[name="gh-branch"]')).toHaveValue("main");
  await expect(gh.locator('[name="gh-branch"] option')).toHaveText(["main (protected)", "develop"]);
  await shot(page, "repo-connect");
  await gh.locator("[data-use]").click();
  await expect(gh).toBeHidden();
  await expect(page.locator("#repo-btn")).toHaveText("octo-dev/shop @ main");
  // the token rode in the proxy header only, and lives in sessionStorage, not localStorage
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.every((s) => !s.url.includes(TOKEN) && s.auth === null)).toBe(true);
  expect(seen.filter((s) => s.token === TOKEN).length).toBeGreaterThan(2);
  const stored = await page.evaluate(() => ({ s: sessionStorage.getItem("overtime:gh-token"), l: JSON.stringify(localStorage) }));
  expect(stored.s).toBe(TOKEN);
  expect(stored.l).not.toContain(TOKEN);
  expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
});

test("worker GitHub proxy refuses ref updates, merges and non-overtime branches", async ({ page, request }) => {
  test.skip(isMobile(page), "desktop only");
  const h = { "x-ot-gh-token": "ghp_e2etest00000000000000000000" };
  expect((await request.fetch("/api/gh/repos/o/r/git/refs/heads/main", { method: "PATCH", headers: h, data: { sha: "x", force: true } })).status()).toBe(403);
  expect((await request.fetch("/api/gh/repos/o/r/git/refs/heads/x", { method: "DELETE", headers: h })).status()).toBe(403);
  expect((await request.fetch("/api/gh/repos/o/r/pulls/1/merge", { method: "PUT", headers: h })).status()).toBe(403);
  const r = await request.post("/api/gh/repos/o/r/git/refs", { headers: h, data: { ref: "refs/heads/main", sha: "abc" } });
  expect(r.status()).toBe(403);
  expect(await r.text()).toContain("overtime/");
  expect((await request.get("/api/gh/user")).status()).toBe(401);
});
