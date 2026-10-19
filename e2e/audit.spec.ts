import { test, expect, type APIRequestContext } from "@playwright/test";
import { trackErrors, isMobile } from "./helpers";

// Bug-hunt regressions (docs/SECURITY_AUDIT.md): switching floors fast never mixes two offices and
// never leaks live streams; the main surfaces fit a 360 px phone.

const now = () => new Date().toISOString();
async function office(request: APIRequestContext, name: string) {
  const r = await request.post("/api/ext/runs", { headers: { "cf-connecting-ip": `10.79.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, data: { agent: "hermes", privacy: "metadata", name } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { runId: string; ingestToken: string; viewToken: string };
}
async function hermes(request: APIRequestContext, o: { runId: string; ingestToken: string }, session: string, batch: Record<string, unknown>[]) {
  const r = await request.post(`/api/ext/runs/${o.runId}/hermes`, { headers: { authorization: `Bearer ${o.ingestToken}` }, data: { batch: batch.map((b) => ({ profile: "default", tool_name: null, tool_input: null, session_id: session, timestamp: now(), ...b })) } });
  expect(r.status()).toBe(200);
}
const tool = (name: string, path: string) => ({ hook_event_name: "post_tool_call", tool_name: name, tool_input: { path }, extra: { status: "ok", duration_ms: 20, tool_call_id: `c${Math.random()}` } });

test("switching floors while one is still loading never shows the other office's events, and leaves one live stream", async ({ page, request }) => {
  const errors = trackErrors(page);
  const a = await office(request, "Floor A");
  const b = await office(request, "Floor B");
  await hermes(request, a, "sa", [{ hook_event_name: "on_session_start", extra: { model: "m", platform: "cli" } }, tool("read_file", "ONLY-IN-A.md")]);
  await hermes(request, b, "sb", [{ hook_event_name: "on_session_start", extra: { model: "m", platform: "cli" } }, tool("read_file", "ONLY-IN-B.md")]);
  const bd = await (await request.post("/api/ext/buildings", { headers: { "cf-connecting-ip": `10.80.${Math.floor(Math.random() * 250)}.1` }, data: { name: "Race" } })).json();
  for (const o of [a, b]) expect((await request.post(`/api/ext/buildings/${bd.buildingId}/floors`, { headers: { authorization: `Bearer ${bd.adminToken}` }, data: { office: o.runId, ingestToken: o.ingestToken } })).status()).toBe(201);
  // count live sockets
  await page.addInitScript(() => {
    const W = window.WebSocket;
    const open = new Set<WebSocket>();
    (window as unknown as { __ws: () => number }).__ws = () => [...open].filter((w) => w.readyState <= 1).length;
    window.WebSocket = class extends W { constructor(u: string | URL, p?: string | string[]) { super(u, p); open.add(this); } } as typeof WebSocket;
  });
  // floor A answers slowly
  await page.route(`**/api/ext/runs/${a.runId}/events*`, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.goto(`/building/${bd.buildingId}#v=${bd.viewToken}`);
  await expect(page.locator(".floor-hot")).toHaveCount(2, { timeout: 20_000 });
  await page.locator('.floor-hot[data-floor="1"]').click();
  const el = page.locator(".elevator");
  await expect(el).toBeVisible({ timeout: 10_000 });
  await el.locator('button[data-room="2"]').click();
  await expect(page.locator("#log")).toContainText("ONLY-IN-B", { timeout: 15_000 });
  await page.waitForTimeout(2500); // floor A's slow answer arrives now
  await expect(page.locator("#log")).not.toContainText("ONLY-IN-A");
  // ride up and down a few times: never more than one live stream
  for (let i = 0; i < 4; i++) {
    await el.locator(`button[data-room="${i % 2 ? 2 : 1}"]`).click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as unknown as { __ws: () => number }).__ws())).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("360 px phones: connect, viewer and building fit without horizontal scrolling", async ({ page, request }) => {
  test.skip(!isMobile(page), "phone layout");
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 360, height: 740 });
  const o = await office(request, "A rather long office name for a small phone");
  await hermes(request, o, "s360", [{ hook_event_name: "on_session_start", extra: { model: "anthropic/claude-sonnet-4-with-a-long-model-name", platform: "telegram" } }, tool("read_file", "src/some/really/long/path/to/a/file/that/goes/on/and/on.ts")]);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.goto("/?target=hermes");
  await expect(page.locator("#hermes-box")).toBeVisible();
  expect(await fits()).toBe(true);
  await page.goto(`/watch/${o.runId}#v=${o.viewToken}`);
  await expect(page.locator("#log")).toContainText("read_file", { timeout: 15_000 });
  expect(await fits()).toBe(true);
  await page.locator('.bar-actions [data-open="insights"]').click();
  await expect(page.locator("#insights")).toBeVisible();
  expect(await fits()).toBe(true);
  expect(errors).toEqual([]);
});
