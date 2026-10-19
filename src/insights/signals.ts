// Internal insight signals: "budget.exceeded" and "session.stuck". Insights emits them; anything
// that wants to notify (Telegram, web push, an email digest) subscribes here, without the insight
// code knowing about it. Documented in docs/EVENTS.md ("Insight signals").
//
//   import { onSignal } from "../insights/signals";
//   const off = onSignal((s) => { if (s.type === "session.stuck") notify(`Hermes looks stuck: ${s.reasons[0].text}`); });
//
// In the browser every signal is also dispatched as a DOM event, so code outside the bundle can
// listen too:  window.addEventListener("overtime:signal", (e) => console.log(e.detail));
//
// Each condition is emitted once: a budget once per period (day / month) and limit, a stuck session
// once per streak (a new streak of evidence emits again). SignalGate does the dedupe.

import type { StuckReason } from "./stuck";

export interface BudgetExceededSignal {
  type: "budget.exceeded";
  /** which limit: the calendar day or the calendar month (local time) */
  period: "day" | "month";
  /** "2026-10-19" or "2026-10" */
  periodKey: string;
  spentUsd: number;
  limitUsd: number;
  office?: string;
  at: number;
}

export interface SessionStuckSignal {
  type: "session.stuck";
  session: string;
  title: string;
  reasons: StuckReason[];
  office?: string;
  at: number;
}

export type InsightSignal = BudgetExceededSignal | SessionStuckSignal;
export type SignalHandler = (s: InsightSignal) => void;

const handlers = new Set<SignalHandler>();

/** Subscribe to insight signals. Returns the unsubscribe function. */
export function onSignal(fn: SignalHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function emitSignal(s: InsightSignal) {
  for (const h of [...handlers]) {
    try { h(s); } catch (e) { console.warn("signal handler failed", e); }
  }
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean; CustomEvent?: typeof CustomEvent };
  if (typeof w.dispatchEvent === "function" && typeof w.CustomEvent === "function") w.dispatchEvent(new w.CustomEvent("overtime:signal", { detail: s }));
}

/** Remembers which signal keys already fired (optionally persisted), so each condition notifies once. */
export class SignalGate {
  private seen: Set<string>;
  constructor(initial: string[] = [], private persist?: (keys: string[]) => void, private max = 200) {
    this.seen = new Set(initial);
  }
  /** true the first time a key is seen */
  first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value as string);
    this.persist?.([...this.seen]);
    return true;
  }
  has(key: string) { return this.seen.has(key); }
}

export const budgetKey = (s: Pick<BudgetExceededSignal, "period" | "periodKey" | "limitUsd">) => `budget:${s.period}:${s.periodKey}:${s.limitUsd}`;
export const stuckKey = (session: string, r: Pick<StuckReason, "kind" | "since">) => `stuck:${session}:${r.kind}:${r.since}`;
