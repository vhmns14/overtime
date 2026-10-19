// How awake the office is. Pure state machine, driven by "an event arrived" and "time passed":
//
//   active ──(quiet ≥ dimAfter)──▶ idle ──(quiet ≥ sleepAfter)──▶ asleep
//     ▲                              │                               │
//     └────────── any event ─────────┘          any event ──▶ waking ─(wakeMs)─▶ active
//
// active: lights on, monitors on. idle: lamps dim, monitors switch off. asleep: everyone dozes at
// their desk (one on the sofa) with Zzz. waking: they stretch. While Hermes waits for a person
// (an approval or a question) the office never dozes off: it is waiting, not idle.

export type Activity = "active" | "idle" | "asleep" | "waking";

export interface ActivityConfig {
  /** quiet time before the lights dim and monitors switch off */
  dimAfterMs: number;
  /** quiet time before everyone falls asleep ("X minutes since Hermes last ran") */
  sleepAfterMs: number;
  /** how long the wake-up stretch lasts */
  wakeMs: number;
}

export const DEFAULT_ACTIVITY: ActivityConfig = { dimAfterMs: 2 * 60_000, sleepAfterMs: 10 * 60_000, wakeMs: 2_600 };

export interface ActivityState {
  mode: Activity;
  /** when the current mode began */
  since: number;
  /** last time Hermes did anything */
  lastEventAt: number;
  /** Hermes is waiting for a person: stay awake */
  holding: boolean;
}

export interface Step {
  state: ActivityState;
  /** set when the mode changed: what the office should play */
  changed?: { from: Activity; to: Activity };
}

function quietMode(quiet: number, cfg: ActivityConfig): Activity {
  if (quiet >= cfg.sleepAfterMs) return "asleep";
  if (quiet >= cfg.dimAfterMs) return "idle";
  return "active";
}

/** Start state from history: an office whose agent last ran hours ago opens asleep, without a show. */
export function initActivity(now: number, lastEventAt: number | null, cfg: ActivityConfig = DEFAULT_ACTIVITY, holding = false): ActivityState {
  const last = lastEventAt ?? now;
  const mode = holding ? "active" : quietMode(Math.max(0, now - last), cfg);
  return { mode, since: now, lastEventAt: last, holding };
}

/** Hermes did something at `ts` (seen at `now`). */
export function onActivity(s: ActivityState, ts: number, now: number, cfg: ActivityConfig = DEFAULT_ACTIVITY, holding = s.holding): Step {
  const lastEventAt = Math.max(s.lastEventAt, Math.min(ts, now));
  const from = s.mode;
  // an old event replayed late (ts long ago) must not wake anyone
  if (now - lastEventAt >= cfg.dimAfterMs && !holding && (from === "idle" || from === "asleep")) {
    return { state: { ...s, lastEventAt, holding } };
  }
  const to: Activity = from === "asleep" ? "waking" : from === "waking" ? "waking" : "active";
  const state = { mode: to, since: to === from ? s.since : now, lastEventAt, holding };
  return to === from ? { state } : { state, changed: { from, to } };
}

/** Time passed. Call it every second or so. */
export function tickActivity(s: ActivityState, now: number, cfg: ActivityConfig = DEFAULT_ACTIVITY, holding = s.holding): Step {
  let to: Activity;
  if (s.mode === "waking") to = now - s.since >= cfg.wakeMs ? (holding ? "active" : quietMode(now - s.lastEventAt, { ...cfg, dimAfterMs: Math.max(cfg.dimAfterMs, cfg.wakeMs) })) : "waking";
  else if (holding) to = "active";
  else {
    const q = quietMode(Math.max(0, now - s.lastEventAt), cfg);
    // falling asleep goes through idle; never skip back up without an event
    to = s.mode === "asleep" ? "asleep" : s.mode === "idle" && q === "active" ? "idle" : q;
  }
  const state = { ...s, holding, mode: to, since: to === s.mode ? s.since : now };
  return to === s.mode ? { state } : { state, changed: { from: s.mode, to } };
}

/** "10m", "90s", "2h", "45" (minutes) → ms; null when unparsable. */
export function parseDuration(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const ms = unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "h" ? n * 3_600_000 : n * 60_000;
  return ms > 0 ? Math.round(ms) : null;
}

/** Config from the page URL: ?sleep=10m&dim=2m (the sleep threshold is "X minutes since Hermes last ran"). */
export function activityConfigFrom(search: string, base: ActivityConfig = DEFAULT_ACTIVITY): ActivityConfig {
  const q = new URLSearchParams(search);
  const sleep = parseDuration(q.get("sleep")) ?? base.sleepAfterMs;
  const dim = Math.min(parseDuration(q.get("dim")) ?? Math.min(base.dimAfterMs, sleep / 2), sleep);
  return { ...base, sleepAfterMs: sleep, dimAfterMs: dim };
}
