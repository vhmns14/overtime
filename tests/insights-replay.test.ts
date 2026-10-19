import { describe, expect, it } from "vitest";
import { buildSchedule, indexAt, ReplayClock, timeOf, realLength, exportSpeed, fmtClock, SPEEDS } from "../src/insights/replay";
import { toTimeline, filterTimeline, countByFilter } from "../src/insights/timeline";
import { sessionEvents, sessionIds } from "../src/insights/sessions";
import { demoEvents, maker } from "./helpers/insights-fixtures";

const at = (...ts: number[]) => ts.map((t) => ({ ts: t }));

describe("replay schedule", () => {
  it("keeps short gaps, squeezes long ones, gives bursts a minimum", () => {
    const s = buildSchedule(at(0, 1000, 1050, 61_050, 62_050), { maxGapMs: 5000, minGapMs: 120, tailMs: 1000 });
    expect(s.at).toEqual([0, 1000, 1120, 6120, 7120]);
    expect(s.total).toBe(8120);
    expect(s.squeezed).toBe(1);
    expect(buildSchedule([]).total).toBe(0);
  });

  it("indexAt counts events at or before t", () => {
    const s = buildSchedule(at(0, 1000, 2000, 3000), { minGapMs: 0, tailMs: 0 });
    expect([indexAt(s, -1), indexAt(s, 0), indexAt(s, 999), indexAt(s, 1000), indexAt(s, 2500), indexAt(s, 1e9)]).toEqual([0, 1, 1, 2, 3, 4]);
    expect(timeOf(s, 2)).toBe(2000);
    expect(timeOf(s, 99)).toBe(s.total);
  });
});

describe("replay clock", () => {
  const s = buildSchedule(at(0, 1000, 2000, 3000, 4000), { minGapMs: 0, tailMs: 1000 }); // total 5000

  it("advances by real ms × speed and returns the events that became due", () => {
    for (const speed of SPEEDS) {
      const c = new ReplayClock(s);
      c.speed = speed;
      c.play();
      const seen: number[] = [];
      let real = 0;
      while (c.playing) {
        const { from, to } = c.tick(50);
        real += 50;
        for (let i = from; i < to; i++) seen.push(i);
      }
      expect(seen).toEqual([0, 1, 2, 3, 4]); // every event exactly once, in order
      expect(real).toBe(Math.ceil(5000 / speed / 50) * 50); // 5 s of replay takes 5 s / speed
      expect(c.ended).toBe(true);
    }
    expect(realLength(s, 4)).toBe(1250);
  });

  it("does nothing while paused; seek returns the count to rebuild to", () => {
    const c = new ReplayClock(s);
    expect(c.tick(1000)).toEqual({ from: 0, to: 0 });
    expect(c.seek(2500)).toBe(3);
    expect(c.t).toBe(2500);
    c.speed = 2;
    c.play();
    expect(c.tick(300)).toEqual({ from: 3, to: 4 }); // 2500 + 600 = 3100
    expect(c.seekToEvent(0)).toBe(1);
    expect(c.seekToEvent(99)).toBe(5);
    expect(c.seek(-50)).toBe(1);
    // play at the end restarts from the beginning
    c.seek(5000);
    expect(c.ended).toBe(true);
    c.play();
    expect(c.t).toBe(0);
  });

  it("jump buttons pick the next and previous event around the cursor", () => {
    const c = new ReplayClock(s);
    c.seekToEvent(2); // count 3
    expect(c.nextEvent()).toBe(3);
    expect(c.prevEvent()).toBe(1);
  });

  it("exports speed up until the clip fits, and format the clock", () => {
    const long = buildSchedule(Array.from({ length: 200 }, (_, i) => ({ ts: i * 3000 })), { tailMs: 0 }); // 597 s
    expect(exportSpeed(long, 2, 20)).toBe(30);
    expect(exportSpeed(s, 4, 20)).toBe(4);
    expect(fmtClock(65_400)).toBe("1:05");
    expect(fmtClock(3_726_000)).toBe("1:02:06");
  });

  it("the recorded demo replays in about a minute at 1x and stays in order", () => {
    const evs = demoEvents();
    const se = sessionEvents(evs, sessionIds(evs)[0]);
    const sc = buildSchedule(se);
    expect(sc.total).toBeGreaterThan(20_000);
    expect(sc.total).toBeLessThan(180_000);
    for (let i = 1; i < sc.at.length; i++) expect(sc.at[i]).toBeGreaterThanOrEqual(sc.at[i - 1]);
  });
});

describe("timeline", () => {
  it("categorizes, filters by category and searches details", () => {
    const evs = demoEvents();
    const items = toTimeline(sessionEvents(evs, sessionIds(evs)[0]));
    const c = countByFilter(items);
    for (const k of ["tools", "errors", "llm", "files", "subagents", "approvals"] as const) expect(c[k]).toBeGreaterThan(0);
    expect(filterTimeline(items, new Set()).length).toBe(items.length);
    const errs = filterTimeline(items, new Set(["errors"]));
    expect(errs.every((i) => i.cats.includes("errors"))).toBe(true);
    expect(errs.some((i) => /pytest|✗/.test(i.title))).toBe(true);
    const both = filterTimeline(items, new Set(["files", "approvals"]));
    expect(both.length).toBe(c.files + c.approvals);
    expect(filterTimeline(items, new Set(), "test_health").length).toBeGreaterThan(0);
    expect(filterTimeline(items, new Set(["llm"]), "test_health")).toEqual([]);
    for (let k = 1; k < items.length; k++) expect(items[k].i).toBeGreaterThan(items[k - 1].i);
    expect(new Set(items.filter((x) => x.type === "tool.start").map((x) => x.title)).size).toBeGreaterThan(5);
  });

  it("details are redacted even if a secret slipped through", () => {
    const { ev } = maker();
    const e = ev({ type: "tool.start", data: { name: "terminal", args_summary: "echo hi" } });
    (e.data as { args_summary: string }).args_summary = "curl -H 'Authorization: Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'";
    const it = toTimeline([e])[0];
    expect(JSON.stringify(it)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(it.detail.find(([k]) => k === "args_summary")![1]).toContain("[redacted]");
  });
});
