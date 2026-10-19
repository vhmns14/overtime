// The office's idle → sleep → wake state machine and the day scoreboard.
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVITY, activityConfigFrom, initActivity, onActivity, parseDuration, tickActivity, type ActivityConfig, type ActivityState } from "../src/office/activity";
import { applyOutcome, newScoreboard, score } from "../src/ext/scoreboard";
import { Ambience } from "../src/office/ambience";

const CFG: ActivityConfig = { dimAfterMs: 60_000, sleepAfterMs: 300_000, wakeMs: 2_000 };
const T0 = 1_792_000_000_000;

function run(s: ActivityState, until: number, step = 1000) {
  const seen: string[] = [];
  for (let t = s.since; t <= until; t += step) {
    const r = tickActivity(s, t, CFG);
    s = r.state;
    if (r.changed) seen.push(`${r.changed.from}>${r.changed.to}@${(t - T0) / 1000}`);
  }
  return { s, seen };
}

describe("activity state machine", () => {
  it("dims after dimAfter, falls asleep after sleepAfter (through idle), and stays asleep", () => {
    const a = initActivity(T0, T0, CFG);
    expect(a.mode).toBe("active");
    const { s, seen } = run(a, T0 + 900_000);
    expect(seen).toEqual(["active>idle@60", "idle>asleep@300"]);
    expect(s.mode).toBe("asleep");
  });

  it("any event wakes a sleeping office with a stretch (waking), then it is active", () => {
    let s = initActivity(T0, T0 - 3_600_000, CFG);
    expect(s.mode).toBe("asleep"); // opened hours after the last run: asleep, no show
    const w = onActivity(s, T0 + 5000, T0 + 5000, CFG);
    expect(w.changed).toEqual({ from: "asleep", to: "waking" });
    s = w.state;
    expect(tickActivity(s, T0 + 6000, CFG).state.mode).toBe("waking");
    const done = tickActivity(s, T0 + 7100, CFG);
    expect(done.changed).toEqual({ from: "waking", to: "active" });
  });

  it("an event while idle just turns the lights back on (no stretch)", () => {
    let s = run(initActivity(T0, T0, CFG), T0 + 120_000).s;
    expect(s.mode).toBe("idle");
    const r = onActivity(s, T0 + 121_000, T0 + 121_000, CFG);
    expect(r.changed).toEqual({ from: "idle", to: "active" });
    s = r.state;
    expect(tickActivity(s, T0 + 150_000, CFG).state.mode).toBe("active");
  });

  it("old events replayed late never wake anyone", () => {
    const s = initActivity(T0, T0 - 3_600_000, CFG);
    const r = onActivity(s, T0 - 3_500_000, T0, CFG);
    expect(r.changed).toBeUndefined();
    expect(r.state.mode).toBe("asleep");
  });

  it("while Hermes waits for a person (approval, question) the office stays awake", () => {
    let s = initActivity(T0, T0, CFG, true);
    for (let t = T0; t < T0 + 900_000; t += 5000) s = tickActivity(s, t, CFG, true).state;
    expect(s.mode).toBe("active");
    // the wait ends: quiet time counts from the last event as usual
    expect(tickActivity(s, T0 + 900_000, CFG, false).state.mode).toBe("asleep");
  });

  it("parses the sleep threshold from the URL (?sleep=10m&dim=2m)", () => {
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("15")).toBe(900_000);
    expect(parseDuration("soon")).toBeNull();
    expect(activityConfigFrom("?sleep=20s&dim=8s")).toMatchObject({ sleepAfterMs: 20_000, dimAfterMs: 8_000 });
    expect(activityConfigFrom("?sleep=30m")).toMatchObject({ sleepAfterMs: 1_800_000, dimAfterMs: DEFAULT_ACTIVITY.dimAfterMs });
    expect(activityConfigFrom("?sleep=1m")).toMatchObject({ sleepAfterMs: 60_000, dimAfterMs: 30_000 }); // dim never after sleep
    expect(activityConfigFrom("")).toEqual(DEFAULT_ACTIVITY);
  });
});

describe("daylight for the window", () => {
  const at = (h: number, m = 0) => { const d = new Date(2026, 9, 19, h, m); return Ambience.daylight(d); };
  it("is dark at night, light at midday, and ramps at dawn and dusk", () => {
    expect(at(2)).toBe(0);
    expect(at(23)).toBe(0);
    expect(at(13)).toBe(1);
    expect(at(6, 30)).toBeGreaterThan(0);
    expect(at(6, 30)).toBeLessThan(1);
    expect(at(18, 30)).toBeGreaterThan(0);
    expect(at(18, 30)).toBeLessThan(1);
  });
});

describe("scoreboard: today's sessions succeeded vs failed", () => {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const end = (session: string, status: string | undefined, ts = T0, final = false) => ({ type: "session.end" as const, ts, session, data: { status, final } as never });

  it("counts each session once per day, by the outcome of its latest turn", () => {
    const sb = newScoreboard();
    expect(applyOutcome(sb, end("a", "completed"), day)).toBe("ok");
    expect(applyOutcome(sb, end("a", "completed", T0 + 1), day)).toBeNull(); // second turn, same outcome
    applyOutcome(sb, end("b", "failed"), day);
    applyOutcome(sb, end("c", "failed"), day);
    applyOutcome(sb, end("c", "completed", T0 + 2), day); // fixed on the next turn
    expect(score(sb, T0, day)).toEqual({ ok: 2, fail: 1 });
  });

  it("ignores interrupted turns and session teardown, and starts fresh the next day", () => {
    const sb = newScoreboard();
    applyOutcome(sb, end("a", "failed"), day);
    expect(applyOutcome(sb, end("a", "interrupted", T0 + 5), day)).toBeNull();
    expect(applyOutcome(sb, end("a", "completed", T0 + 6, true), day)).toBeNull();
    expect(score(sb, T0, day)).toEqual({ ok: 0, fail: 1 });
    expect(score(sb, T0 + 86_400_000, day)).toEqual({ ok: 0, fail: 0 });
  });
});
