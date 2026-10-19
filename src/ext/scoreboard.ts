// The wall scoreboard: how many of today's sessions succeeded and how many failed.
//
// Hermes ends every turn with on_session_end, so one session can end many times; a session counts
// once per day, with the outcome of its latest turn that day. Interrupted turns don't change the
// score (you stopped it). "Today" is the viewer's local day unless a day function is given.

import type { ExtEvent } from "./schema";

export type Outcome = "ok" | "fail";

export interface Scoreboard {
  /** day key → session id → latest outcome that day */
  days: Record<string, Record<string, Outcome>>;
}

export const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function newScoreboard(): Scoreboard {
  return { days: {} };
}

/** Applies a session.end; returns the outcome when the score changed, else null. */
export function applyOutcome(sb: Scoreboard, e: Pick<ExtEvent, "type" | "ts" | "session" | "data">, day: (ts: number) => string = localDay): Outcome | null {
  if (e.type !== "session.end") return null;
  const { status: st, final } = e.data as { status?: string; final?: boolean };
  if (final) return null; // a session being torn down is not a turn outcome
  const out: Outcome | null = st === "failed" ? "fail" : st === "completed" || st === undefined ? "ok" : null;
  if (!out) return null;
  const k = day(e.ts);
  const m = (sb.days[k] ??= {});
  const was = m[e.session];
  m[e.session] = out;
  const keys = Object.keys(sb.days);
  if (keys.length > 14) for (const old of keys.sort().slice(0, keys.length - 14)) delete sb.days[old];
  return was === out ? null : out;
}

export function score(sb: Scoreboard, now = Date.now(), day: (ts: number) => string = localDay): { ok: number; fail: number } {
  const m = sb.days[day(now)] ?? {};
  let ok = 0, fail = 0;
  for (const v of Object.values(m)) v === "ok" ? ok++ : fail++;
  return { ok, fail };
}
