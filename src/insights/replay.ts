// Replay timing: maps a session's events onto a virtual timeline (long idle gaps squeezed, so a
// session that waited 40 minutes for you does not replay 40 minutes of nothing) and a clock that
// advances it at 1x–16x. Pure and deterministic: the UI feeds it real elapsed milliseconds.

import type { ExtEvent } from "../ext/schema";

export const SPEEDS = [1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

export interface Schedule {
  /** virtual ms offset of each event from the first one */
  at: number[];
  /** virtual length of the whole replay */
  total: number;
  /** real gaps that were squeezed, for the scrubber's "…" marks */
  squeezed: number;
}

export interface ScheduleOpts {
  /** a gap longer than this (real ms) replays as exactly this long */
  maxGapMs?: number;
  /** events closer than this still get this much room, so a burst does not flash past */
  minGapMs?: number;
  /** a little air after the last event */
  tailMs?: number;
}

export const DEFAULT_SCHEDULE: Required<ScheduleOpts> = { maxGapMs: 5000, minGapMs: 120, tailMs: 1500 };

export function buildSchedule(events: readonly Pick<ExtEvent, "ts">[], opts: ScheduleOpts = {}): Schedule {
  const o = { ...DEFAULT_SCHEDULE, ...opts };
  const at: number[] = [];
  let t = 0, squeezed = 0;
  for (let i = 0; i < events.length; i++) {
    if (i > 0) {
      const gap = Math.max(0, events[i].ts - events[i - 1].ts);
      if (gap > o.maxGapMs) squeezed++;
      t += Math.max(o.minGapMs, Math.min(o.maxGapMs, gap));
    }
    at.push(t);
  }
  return { at, total: events.length ? t + o.tailMs : 0, squeezed };
}

/** How many events have happened at virtual time t (events at exactly t count). */
export function indexAt(s: Schedule, t: number): number {
  let lo = 0, hi = s.at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.at[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const timeOf = (s: Schedule, i: number) => (i <= 0 ? 0 : i >= s.at.length ? s.total : s.at[i]);

/** Real seconds the whole replay takes at a speed. */
export const realLength = (s: Schedule, speed: number) => s.total / Math.max(0.0001, speed);

/**
 * The replay clock. `tick(realMs)` advances virtual time by realMs × speed and returns the range of
 * event indexes that became due, [from, to). Seeking never returns events: the caller rebuilds the
 * state up to `count` without animation.
 */
export class ReplayClock {
  t = 0;
  playing = false;
  speed: number = 1;
  /** events applied so far */
  count = 0;
  constructor(public schedule: Schedule) {}

  get ended() { return this.t >= this.schedule.total; }

  play() { if (this.ended) this.seek(0); this.playing = true; }
  pause() { this.playing = false; }

  tick(realMs: number): { from: number; to: number } {
    const from = this.count;
    if (!this.playing) return { from, to: from };
    this.t = Math.min(this.schedule.total, this.t + Math.max(0, realMs) * this.speed);
    this.count = indexAt(this.schedule, this.t);
    if (this.ended) this.playing = false;
    return { from, to: this.count };
  }

  /** Jump to a virtual time; returns the event count the state must be rebuilt to. */
  seek(t: number): number {
    this.t = Math.max(0, Math.min(this.schedule.total, t));
    this.count = indexAt(this.schedule, this.t);
    return this.count;
  }

  /** Jump so that event i (0-based) has just happened. */
  seekToEvent(i: number): number {
    const k = Math.max(0, Math.min(this.schedule.at.length - 1, i));
    return this.seek(this.schedule.at[k] ?? 0);
  }

  /** Index of the next / previous event relative to the cursor, for the jump buttons. */
  nextEvent(): number { return Math.min(this.schedule.at.length - 1, this.count); }
  prevEvent(): number { return Math.max(0, this.count - 2); }
}

/** mm:ss for the scrubber. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

/** The speed an export runs at: the chosen one, raised until the clip fits in maxSeconds. */
export function exportSpeed(s: Schedule, chosen: number, maxSeconds: number): number {
  const need = s.total / 1000 / Math.max(1, maxSeconds);
  return Math.max(chosen, Math.ceil(need));
}
