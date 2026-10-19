import { describe, expect, it } from "vitest";
import { detectStuck, DEFAULT_STUCK, normalizeThresholds, turnState, median } from "../src/insights/stuck";
import { sessionEvents, sessionIds } from "../src/insights/sessions";
import { budgetStatus, normalizeBudget } from "../src/insights/budget";
import { emitSignal, onSignal, SignalGate, budgetKey, stuckKey, type InsightSignal } from "../src/insights/signals";
import { demoEvents, maker } from "./helpers/insights-fixtures";

const th = { ...DEFAULT_STUCK, idleMin: 0 };

describe("stuck heuristics", () => {
  it("the same tool with the same args N times in a row", () => {
    const { ev, now } = maker();
    const e = [ev({ type: "session.start", data: {} })];
    for (let i = 0; i < 3; i++) e.push(ev({ type: "tool.start", data: { name: "terminal", call_id: `c${i}`, target: "npm run test" } }), ev({ type: "tool.end", data: { name: "terminal", call_id: `c${i}`, ok: true, target: "npm run test" } }));
    expect(detectStuck(e, now(), th)).toEqual([]); // 3 < 4, and start+end of one call count once
    e.push(ev({ type: "llm.call", data: { input_tokens: 10 } }), ev({ type: "tool.start", data: { name: "terminal", call_id: "c4", target: "npm run test" } }));
    const r = detectStuck(e, now(), th);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "repeat-tool", tool: "terminal" });
    expect(r[0].text).toMatch(/terminal npm run test 4 times in a row/);
    expect(r[0].since).toBe(e[1].seq);
    // a different call breaks the streak
    e.push(ev({ type: "tool.start", data: { name: "read_file", call_id: "c5", target: "a.py" } }));
    expect(detectStuck(e, now(), th)).toEqual([]);
  });

  it("different arguments are not a repeat; tool.end without a start still counts", () => {
    const { ev, now } = maker();
    const e = [1, 2, 3, 4].map((i) => ev({ type: "tool.start", data: { name: "read_file", target: `f${i}.py` } }));
    expect(detectStuck(e, now(), th)).toEqual([]);
    const f = [1, 2, 3, 4].map(() => ev({ type: "tool.end", data: { name: "web_search", ok: true, target: "docs.python.org" } }));
    expect(detectStuck(f, now(), th)[0]?.kind).toBe("repeat-tool");
  });

  it("repeated errors among the latest results", () => {
    const { ev, now } = maker();
    const e = [
      ev({ type: "tool.end", data: { name: "terminal", ok: false, error: "exit 1" } }),
      ev({ type: "tool.end", data: { name: "patch", ok: true } }),
      ev({ type: "tool.end", data: { name: "terminal", ok: false, error: "exit 1" } }),
    ];
    expect(detectStuck(e, now(), th)).toEqual([]);
    e.push(ev({ type: "error", data: { message: "rate limited" } }));
    const r = detectStuck(e, now(), th);
    expect(r.map((x) => x.kind)).toEqual(["repeat-error"]);
    expect(r[0].text).toMatch(/3 of the last 4 tool results failed \(latest: rate limited\)/);
    // a success at the end means it recovered
    e.push(ev({ type: "tool.end", data: { name: "terminal", ok: true } }));
    expect(detectStuck(e, now(), th)).toEqual([]);
  });

  it("a test run that 'succeeded' but printed failures counts as a failure", () => {
    const { ev, now } = maker();
    const e = [1, 2, 3].map((i) => ev({ type: "tool.end", data: { name: "terminal", ok: true, target: `python -m pytest -k t${i}`, output_summary: "F\n1 failed in 0.4s" } }));
    const r = detectStuck(e, now(), th);
    expect(r.map((x) => x.kind)).toEqual(["repeat-error"]);
    expect(r[0].text).toContain("terminal: 1 failed in 0.4s");
  });

  it("silence while a turn runs, but not while waiting for approval, and not after the turn ended", () => {
    const { ev, now } = maker();
    const e = [ev({ type: "session.start", data: {} }), ev({ type: "tool.start", data: { name: "terminal", call_id: "x" } })];
    const t = { ...DEFAULT_STUCK, idleMin: 10 };
    expect(detectStuck(e, now() + 9 * 60_000, t)).toEqual([]);
    const r = detectStuck(e, now() + 12 * 60_000, t);
    expect(r).toMatchObject([{ kind: "idle", text: "No events for 12 min while a turn is running" }]);
    const waiting = [...e, ev({ type: "approval.request", data: { command: "sudo x" } })];
    expect(turnState(waiting)).toMatchObject({ open: true, waiting: true });
    expect(detectStuck(waiting, now() + 60 * 60_000, t)).toEqual([]);
    const answered = [...waiting, ev({ type: "approval.response", data: { choice: "once" } })];
    expect(detectStuck(answered, now() + 60 * 60_000, t)[0]?.kind).toBe("idle");
    const ended = [...answered, ev({ type: "session.end", data: { status: "completed" } })];
    expect(detectStuck(ended, now() + 60 * 60_000, t)).toEqual([]);
  });

  it("a cost spike on the latest model call", () => {
    const { ev, now } = maker();
    const e = [0.004, 0.005, 0.006, 0.005].map((c) => ev({ type: "llm.call", data: { cost_usd: c } }));
    expect(detectStuck(e, now(), th)).toEqual([]);
    e.push(ev({ type: "llm.call", data: { cost_usd: 0.04 } })); // 8× but under the $0.05 floor
    expect(detectStuck(e, now(), th)).toEqual([]);
    e.push(ev({ type: "llm.call", data: { cost_usd: 0.09 } }));
    const r = detectStuck(e, now(), th);
    expect(r[0]).toMatchObject({ kind: "cost-spike" });
    expect(r[0].text).toMatch(/\$0\.090/);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("the recorded demo never looks stuck at any point", () => {
    const evs = demoEvents();
    const s = sessionEvents(evs, sessionIds(evs)[0]);
    for (let i = 1; i <= s.length; i++) expect(detectStuck(s.slice(0, i), s[i - 1].ts, DEFAULT_STUCK)).toEqual([]);
  });

  it("disabled, and thresholds are validated", () => {
    const { ev, now } = maker();
    const e = [1, 2, 3, 4, 5].map(() => ev({ type: "tool.end", data: { name: "x", ok: false } }));
    expect(detectStuck(e, now(), { ...th, enabled: false })).toEqual([]);
    const n = normalizeThresholds({ repeatTool: 1, idleMin: -5, costSpikeX: Number.NaN, enabled: false } as never);
    expect(n).toMatchObject({ repeatTool: 2, idleMin: 0, costSpikeX: DEFAULT_STUCK.costSpikeX, enabled: false });
    expect(normalizeThresholds(null)).toEqual(DEFAULT_STUCK);
  });
});

describe("budget + signals", () => {
  it("levels: ok, warn from 80 %, over; the worse limit wins", () => {
    const cfg = normalizeBudget({ dailyUsd: 1, monthlyUsd: 10 });
    expect(budgetStatus({ day: 0.5, month: 2 }, cfg).level).toBe("ok");
    expect(budgetStatus({ day: 0.85, month: 2 }, cfg)).toMatchObject({ level: "warn", period: "day" });
    expect(budgetStatus({ day: 0.2, month: 10.5 }, cfg)).toMatchObject({ level: "over", period: "month", limitUsd: 10 });
    expect(budgetStatus({ day: 5, month: 5 }, normalizeBudget({}))).toMatchObject({ level: "ok", period: null });
    expect(normalizeBudget({ dailyUsd: -3, monthlyUsd: 0 } as never)).toMatchObject({ dailyUsd: null, monthlyUsd: null });
  });

  it("emits to subscribers and as a DOM-style event; the gate lets each condition through once", () => {
    const got: InsightSignal[] = [];
    const off = onSignal((s) => got.push(s));
    const persisted: string[][] = [];
    const gate = new SignalGate([], (k) => persisted.push(k));
    const sig = { type: "budget.exceeded" as const, period: "day" as const, periodKey: "2026-10-19", spentUsd: 1.2, limitUsd: 1, at: 1 };
    if (gate.first(budgetKey(sig))) emitSignal(sig);
    if (gate.first(budgetKey(sig))) emitSignal(sig);
    if (gate.first(budgetKey({ ...sig, periodKey: "2026-10-20" }))) emitSignal({ ...sig, periodKey: "2026-10-20" });
    off();
    emitSignal(sig);
    expect(got.map((s) => (s as typeof sig).periodKey)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(persisted.at(-1)).toHaveLength(2);
    expect(stuckKey("s1", { kind: "idle", since: 4 })).toBe("stuck:s1:idle:4");
    expect(new SignalGate(["a"]).first("a")).toBe(false);
  });
});
