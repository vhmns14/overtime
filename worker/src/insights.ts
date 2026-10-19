// Insights for an office: the events the cost dashboard needs (model calls and session starts /
// ends) for the whole office, not just what a browser loaded. Child sessions (Hermes subagents)
// are folded into their parent here, so the client aggregates exactly like the office reducer.

import type { ExtEvent } from "../../src/ext/schema";

export const INSIGHT_TYPES = ["llm.call", "session.start", "session.end", "message"] as const;
export const INSIGHT_LIMIT = 20_000;

/** Newest INSIGHT_LIMIT insight events, oldest first, child sessions attributed to the parent. */
export function insightEvents(sql: SqlStorage, limit = INSIGHT_LIMIT): { events: ExtEvent[]; truncated: boolean } {
  const rows = sql.exec<{ body: string; seq: number; parent: string | null }>(
    `SELECT e.body AS body, e.seq AS seq, c.parent AS parent FROM events e LEFT JOIN children c ON c.child = e.session
     WHERE e.type IN (${INSIGHT_TYPES.map(() => "?").join(", ")}) ORDER BY e.seq DESC LIMIT ?`,
    ...INSIGHT_TYPES, limit + 1,
  ).toArray();
  const truncated = rows.length > limit;
  const events: ExtEvent[] = [];
  for (const r of rows.slice(0, limit).reverse()) {
    const e = { ...(JSON.parse(r.body) as ExtEvent), seq: r.seq };
    if (r.parent) {
      if (e.type === "session.start" || e.type === "session.end") continue;
      // keep only the user's own messages of the parent: a child's messages say nothing about cost
      if (e.type === "message") continue;
      events.push({ ...e, session: r.parent });
    } else if (e.type !== "message" || (e.data as { role?: string }).role === "user") events.push(e);
  }
  return { events, truncated };
}
