import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { trackErrors, isMobile } from "./helpers";

// XSS sweep (docs/SECURITY_AUDIT.md): every string an agent controls carries an HTML/attribute
// break-out payload, at the "full" privacy level, and every view that shows event content is opened:
// the panel log, the office (name tags, plan whiteboard, approval card), the library (bookshelf
// tooltips and panel), Insights (summary card, timeline, costs), toasts, a building with hostile
// floor names, and the read-only viewer. No payload may become markup, and the CSP must never have
// to block anything (a blocked inline handler is a console error).

const P = `x"'><img src=x id=pwn onerror="window.__xss=1"><svg id=pwn2 onload="window.__xss=2"></svg><a id=pwn3 href="javascript:window.__xss=3">j</a>`;
const short = (n: number) => P.slice(0, n);

async function office(request: APIRequestContext, name: string) {
  const r = await request.post("/api/ext/runs", { headers: { "cf-connecting-ip": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, data: { agent: "hermes", privacy: "full", name } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { runId: string; ingestToken: string; viewToken: string; webhookSecret: string };
}

async function seed(request: APIRequestContext, o: { runId: string; ingestToken: string }) {
  const t0 = Date.now() - 60_000;
  const s = "xss-session";
  const ev = (type: string, data: Record<string, unknown>, i: number, extra: Record<string, unknown> = {}) => ({ type, session: s, ts: t0 + i * 1000, data, ...extra });
  const events = [
    ev("session.start", { title: P, model: short(190), platform: short(60), profile: short(60), cwd: P }, 0),
    ev("message", { role: "user", text: P }, 1),
    ev("plan.update", { items: [{ text: short(190), status: "doing" }, { id: short(60), text: P.slice(10, 190), status: "todo" }] }, 2),
    ev("llm.call", { model: short(190), provider: short(60), input_tokens: 1200, output_tokens: 300, cost_usd: 0.0021, duration_ms: 900, finish_reason: short(60) }, 3),
    ev("tool.start", { name: short(120), call_id: "c1", args_summary: P, target: P }, 4),
    ev("tool.end", { name: short(120), call_id: "c1", ok: false, status: short(30), error: P, output_summary: P, target: P }, 5),
    ev("file.write", { path: P, op: "write" }, 6),
    ev("subagent.start", { id: "sub1", name: short(78), role: short(78), goal: P, child_session: "child1" }, 7),
    ev("tool.start", { name: "web_search", call_id: "c2", args_summary: P }, 8, { session: "child1", agent: "sub1" }),
    ev("subagent.stop", { id: "sub1", status: short(30), summary: P }, 9),
    ev("skill.update", { name: short(120), action: "created", source: "tool" }, 10),
    ev("skill.update", { name: short(120), action: "patched", source: short(30) }, 11),
    ev("memory.write", { action: "add", target: "memory", source: short(30) }, 12),
    ev("agent.thinking", { text: P }, 13),
    ev("error", { message: P, kind: short(60) }, 14),
    ev("human_input.request", { id: "h1", kind: short(30), prompt: P }, 15),
    ev("human_input.resolved", { id: "h1", outcome: short(30) }, 16),
    ev("approval.request", { id: "a1", command: P, description: P, surface: "gateway", pattern: short(120) }, 17),
    ev("message", { role: "assistant", text: P }, 18),
  ];
  const r = await request.post(`/api/ext/runs/${o.runId}/events`, { headers: { authorization: `Bearer ${o.ingestToken}` }, data: { events } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.rejected).toEqual([]);
}

/** No payload ever turned into an element, attribute handler or javascript: link, and nothing ran. */
async function assertClean(page: Page, where: string) {
  const found = await page.evaluate(() => ({
    nodes: document.querySelectorAll("#pwn, #pwn2, #pwn3, img[src='x']").length,
    handlers: [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).map((el) => el.outerHTML.slice(0, 120)),
    jsLinks: [...document.querySelectorAll("a[href^='javascript' i]")].length,
    ran: (window as unknown as { __xss?: number }).__xss ?? 0,
  }));
  expect(found, where).toEqual({ nodes: 0, handlers: [], jsLinks: 0, ran: 0 });
}

test("XSS: hostile event content in every view of an office stays text", async ({ page, request }) => {
  const errors = trackErrors(page);
  const o = await office(request, short(58));
  await seed(request, o);
  await page.goto(`/watch/${o.runId}?clock=14:30#v=${o.viewToken}`);
  await expect(page.locator("#log")).toContainText("img src=x", { timeout: 20_000 }); // shown, as text
  await assertClean(page, "office + panel");

  // the session picker, the agent cards
  const box = page.locator("#hermes-box");
  await expect(box).toBeVisible();
  await assertClean(page, "hermes box");

  // library: bookshelf tooltip + the Library panel
  if (!isMobile(page) && (await page.locator(".prop-book").count())) {
    await page.locator(".prop-book").first().hover();
    await assertClean(page, "library hover");
    await page.locator(".prop-book").first().click();
  } else if (await page.locator("#library summary").count()) {
    // on a phone the Library lives in the bottom sheet, under the log
    await page.locator("#library summary").evaluate((el: HTMLElement) => el.click());
    await expect(page.locator("#library")).toHaveAttribute("open", "");
  }
  await assertClean(page, "library panel");

  // Insights: every tab
  const open = isMobile(page) ? page.locator('.bar-actions [data-open="insights"]') : page.locator('.panel [data-open="insights"]').first();
  await open.click();
  const ov = page.locator("#insights");
  await expect(ov).toBeVisible();
  const tabs = ov.locator("[data-tab]");
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(150);
    await assertClean(page, `insights tab ${await tabs.nth(i).getAttribute("data-tab")}`);
  }
  // timeline search with a hostile query (it is echoed in the empty state)
  const tl = ov.locator('[data-tab="timeline"]');
  if (await tl.count()) {
    await tl.click();
    const q = ov.locator('[data-tl="q"]');
    if (await q.count()) { await q.fill(P); await page.waitForTimeout(150); await assertClean(page, "timeline search"); }
  }
  expect(errors).toEqual([]);
});

test("XSS: hostile building and floor names", async ({ page, request }) => {
  const errors = trackErrors(page);
  const o = await office(request, short(58));
  await seed(request, o);
  const b = await request.post("/api/ext/buildings", { headers: { "cf-connecting-ip": `10.78.${Math.floor(Math.random() * 250)}.1` }, data: { name: short(58) } });
  expect(b.status()).toBe(201);
  const bj = await b.json();
  const f = await request.post(`/api/ext/buildings/${bj.buildingId}/floors`, { headers: { authorization: `Bearer ${bj.adminToken}` }, data: { office: o.runId, ingestToken: o.ingestToken, name: P.slice(0, 58) } });
  expect(f.status()).toBe(201);
  await page.goto(`/building/${bj.buildingId}#v=${bj.viewToken}`);
  await expect(page.locator(".floor-hot")).toHaveCount(1, { timeout: 20_000 });
  await assertClean(page, "building view");
  await page.locator(".floor-hot").first().hover().catch(() => undefined);
  await assertClean(page, "floor hover");
  await page.locator('.floor-hot[data-floor="1"]').click();
  await expect(page.locator(".elevator")).toBeVisible({ timeout: 10_000 });
  await assertClean(page, "floor via elevator");
  expect(errors).toEqual([]);
});
