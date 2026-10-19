// Spending limits per calendar day and month (local time), checked against Hermes' own cost
// estimates. Crossing a limit raises a banner and emits "budget.exceeded" (signals.ts) once per
// period. Overtime never stops Hermes: the budget is a warning, not a kill switch.

export interface BudgetConfig {
  /** USD per calendar day, null for no limit */
  dailyUsd: number | null;
  /** USD per calendar month, null for no limit */
  monthlyUsd: number | null;
  /** warn from this share of a limit (0.8 = 80 %) */
  warnAt: number;
}

export const DEFAULT_BUDGET: BudgetConfig = { dailyUsd: null, monthlyUsd: null, warnAt: 0.8 };

export interface BudgetStatus {
  level: "ok" | "warn" | "over";
  /** the limit that decides the level (the worse one) */
  period: "day" | "month" | null;
  spentUsd: number;
  limitUsd: number;
  share: number;
}

export function budgetStatus(spent: { day: number; month: number }, cfg: BudgetConfig): BudgetStatus {
  const checks: BudgetStatus[] = [];
  const one = (period: "day" | "month", s: number, lim: number | null) => {
    if (lim === null || !(lim > 0)) return;
    const share = s / lim;
    checks.push({ level: share >= 1 ? "over" : share >= cfg.warnAt ? "warn" : "ok", period, spentUsd: s, limitUsd: lim, share });
  };
  one("day", spent.day, cfg.dailyUsd);
  one("month", spent.month, cfg.monthlyUsd);
  if (!checks.length) return { level: "ok", period: null, spentUsd: 0, limitUsd: 0, share: 0 };
  const rank = { ok: 0, warn: 1, over: 2 };
  return checks.sort((a, b) => rank[b.level] - rank[a.level] || b.share - a.share)[0];
}

export function normalizeBudget(x: Partial<BudgetConfig> | null | undefined): BudgetConfig {
  const lim = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(1e6, v) : null);
  const o = x ?? {};
  const w = typeof o.warnAt === "number" && o.warnAt > 0 && o.warnAt < 1 ? o.warnAt : DEFAULT_BUDGET.warnAt;
  return { dailyUsd: lim(o.dailyUsd), monthlyUsd: lim(o.monthlyUsd), warnAt: w };
}
