import { describe, expect, it } from "vitest";
import { sessionStats, costByDay, costByModel, costBySession, spendNow, dayKey, llmCost, sessionTitles } from "../src/insights/aggregate";
import { attribute, sessionEvents, sessionIds, childMap } from "../src/insights/sessions";
import { whatWasDone, summaryMarkdown, llmSummaryPrompt, fmtDuration, fmtUsd, headline } from "../src/insights/summary";
import { replay } from "../src/ext/office-state";
import { demoEvents, maker, T0 } from "./helpers/insights-fixtures";

describe("sessions", () => {
  it("folds a subagent's own session into its parent, at that subagent", () => {
    const evs = demoEvents();
    const ids = sessionIds(evs);
    expect(ids).toHaveLength(1);
    const kids = childMap(evs);
    expect(Object.keys(kids).length).toBeGreaterThan(0);
    const att = attribute(evs);
    expect(att.every((e) => e.session === ids[0])).toBe(true);
    expect(att.some((e) => e.agent !== "main")).toBe(true);
    // a child's session.start/end never becomes an office session
    expect(att.filter((e) => e.type === "session.start")).toHaveLength(1);
  });

  it("sorts one session by time, then seq", () => {
    const { ev } = maker();
    const a = ev({ type: "tool.start", data: { name: "a" } }, 1000);
    const b = ev({ type: "tool.start", data: { name: "b" } }, 1000);
    const c = { ...ev({ type: "tool.start", data: { name: "c" } }, 1000), ts: a.ts };
    expect(sessionEvents([b, c, a], "s1").map((e) => (e.data as { name: string }).name)).toEqual(["a", "c", "b"]);
  });
});

describe("session stats (summary card)", () => {
  const evs = demoEvents();
  const id = sessionIds(evs)[0];
  const s = sessionStats(evs, id);

  it("matches the office reducer on cost, tokens and files", () => {
    const st = replay(evs);
    const v = st.sessions[id];
    expect(s.usd).toBeCloseTo(v.cost.usd, 10);
    expect(s.tokens.total).toBe(v.cost.tokens);
    expect(s.calls).toBe(v.cost.calls);
    expect(s.files.map((f) => f.path).sort()).toEqual([...v.files].sort());
  });

  it("derives what was done: plan, files, tests (a failure then green), the subagent and the approval", () => {
    expect(s.title).toMatch(/health endpoint/i);
    expect(s.models).toContain("anthropic/claude-sonnet-4");
    expect(s.status).not.toBe("open");
    expect(s.plan.length).toBe(5);
    expect(s.tests.some((t) => !t.ok)).toBe(true);
    expect(s.tests.at(-1)!.ok).toBe(true);
    expect(s.subagents).toMatchObject([{ name: "Check FastAPI docs", status: "done" }]);
    expect(s.approvals.length).toBe(1);
    expect(s.approvals[0].choice).toBeTruthy();
    expect(s.errors.length).toBeGreaterThanOrEqual(1);
    expect(s.tools[0].count).toBeGreaterThanOrEqual(s.tools.at(-1)!.count);
    const done = whatWasDone(s).join("\n");
    expect(done).toMatch(/Planned 5 steps, finished 5/);
    expect(done).toMatch(/Changed 2 files/);
    expect(done).toMatch(/1 failed, green at the end/);
    expect(done).toMatch(/subagent “Check FastAPI docs”/);
    expect(done).toMatch(/Asked for approval/);
    expect(s.durationMs).toBeGreaterThan(10_000);
    expect(headline(s)).toContain(fmtUsd(s.usd));
  });

  it("renders markdown with every section and the made-with line", () => {
    const md = summaryMarkdown(s, { when: "Oct 19, 2026" });
    for (const h of ["## ", "### What was done", "### Files changed", "### Top tools", "### Errors", "### Models and tokens", "_Made with Overtime_"]) expect(md).toContain(h);
    expect(md).toContain("`app/main.py`");
  });

  it("the optional model prompt carries derived facts only, fenced as data", () => {
    const p = llmSummaryPrompt(s);
    expect(p.user.startsWith("<data>")).toBe(true);
    const facts = JSON.parse(p.user.slice(6, -7));
    expect(Object.keys(facts)).toEqual(expect.arrayContaining(["title", "what_was_done", "files", "top_tools", "errors"]));
    expect(p.user).not.toContain("tool_input");
  });

  it("an empty or chat-only session still has a sentence", () => {
    const { ev } = maker("chat");
    const e = [ev({ type: "session.start", data: { platform: "telegram" } }), ev({ type: "message", data: { role: "user", text: "what's the weather" } }), ev({ type: "llm.call", data: { model: "openai/gpt-4o-mini", input_tokens: 100, output_tokens: 20 } })];
    const s2 = sessionStats(e, "chat");
    expect(s2.title).toBe("what's the weather");
    expect(whatWasDone(s2)).toEqual(["Answered with 1 model call, no tools"]);
    expect(fmtDuration(65_000)).toBe("1m 05s");
  });
});

describe("cost aggregations", () => {
  const JKT = -420; // UTC+7, as Date#getTimezoneOffset reports it
  function office() {
    const a = maker("a", T0 - 2 * 86_400_000), b = maker("b", T0), c = maker("c", T0 + 3600_000);
    return [
      a.ev({ type: "session.start", data: { title: "Two days ago" } }),
      a.ev({ type: "llm.call", data: { model: "anthropic/claude-sonnet-4", input_tokens: 10_000, output_tokens: 1000 } }), // 0.03 + 0.015
      b.ev({ type: "session.start", data: { title: "Today" } }),
      b.ev({ type: "llm.call", data: { model: "openai/gpt-4o-mini", cost_usd: 0.01, input_tokens: 5000, output_tokens: 100 } }),
      b.ev({ type: "llm.call", data: { model: "mystery-model", input_tokens: 700, output_tokens: 30 } }),
      c.ev({ type: "llm.call", data: { model: "openai/gpt-4o-mini", cost_usd: 0.02, input_tokens: 1000, output_tokens: 10 } }),
    ];
  }

  it("prices like the reducer: cost_usd first, then the table, else unpriced", () => {
    expect(llmCost({ model: "x", cost_usd: 0.5, input_tokens: 1 }).usd).toBe(0.5);
    expect(llmCost({ model: "anthropic/claude-sonnet-4", input_tokens: 1e6 }).usd).toBeCloseTo(3);
    expect(llmCost({ model: "nope", input_tokens: 1e6 }).usd).toBeNull();
  });

  it("buckets per local day with zeros filled in", () => {
    const pts = costByDay(office(), { now: T0 + 2 * 3600_000, days: 4, offsetMin: JKT });
    expect(pts.map((p) => p.key)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(pts[1].usd).toBeCloseTo(0.045, 6);
    expect(pts[2].usd).toBe(0);
    expect(pts[3].usd).toBeCloseTo(0.03, 6);
    expect(pts[3].calls).toBe(3);
    expect(pts[3].unpriced).toBe(1);
    expect(pts[3].label).toBe("Oct 19");
  });

  it("uses the time zone for the day boundary", () => {
    const late = Date.UTC(2026, 9, 18, 20, 0, 0); // 03:00 next day in UTC+7, 13:00 in UTC-7
    expect(dayKey(late, JKT)).toBe("2026-10-19");
    expect(dayKey(late, 420)).toBe("2026-10-18");
  });

  it("groups per model and per session, most expensive first", () => {
    const evs = office();
    const m = costByModel(evs);
    expect(m.map((x) => x.key)).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o-mini", "mystery-model"]);
    expect(m[1].calls).toBe(2);
    const s = costBySession(evs, sessionTitles(evs));
    expect(s[0]).toMatchObject({ key: "a", label: "Two days ago" });
    expect(s.map((x) => x.key)).toContain("c");
  });

  it("spend today and this month for budgets", () => {
    const sp = spendNow(office(), { now: T0 + 2 * 3600_000, offsetMin: JKT });
    expect(sp.dayKey).toBe("2026-10-19");
    expect(sp.day).toBeCloseTo(0.03, 6);
    expect(sp.month).toBeCloseTo(0.075, 6);
  });
});
