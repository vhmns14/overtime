// Groups an office's raw event stream into sessions the way the office reducer does: events from a
// subagent's own session (Hermes runs subagents in a child session) belong to the parent session,
// at that subagent. Pure; shared by the replay, the timeline, the summary card, the cost dashboard
// and stuck detection.

import type { EventData, ExtEvent } from "../ext/schema";

/** child session id → parent session id, from subagent.start events (child_session, else the subagent id). */
export function childMap(events: readonly ExtEvent[]): Record<string, { parent: string; id: string }> {
  const m: Record<string, { parent: string; id: string }> = {};
  for (const e of events) {
    if (e.type !== "subagent.start") continue;
    const d = e.data as EventData["subagent.start"];
    const parent = m[e.session]?.parent ?? e.session;
    if (d.child_session) m[d.child_session] = { parent, id: d.id };
    m[d.id] ??= { parent, id: d.id };
  }
  return m;
}

/**
 * Re-attributes events from child sessions to their parent session (agent = the subagent id) and
 * drops a child session's own session.start / session.end. Order is kept.
 */
export function attribute(events: readonly ExtEvent[]): ExtEvent[] {
  const m = childMap(events);
  const out: ExtEvent[] = [];
  for (const e of events) {
    const c = m[e.session];
    if (!c) { out.push(e); continue; }
    if (e.type === "session.start" || e.type === "session.end") continue;
    out.push({ ...e, session: c.parent, agent: e.agent === "main" ? c.id : e.agent });
  }
  return out;
}

/** One session's events (its subagents' included), sorted by time then seq. */
export function sessionEvents(events: readonly ExtEvent[], session: string): ExtEvent[] {
  return sortEvents(attribute(events).filter((e) => e.session === session));
}

export function sortEvents(events: ExtEvent[]): ExtEvent[] {
  return events.slice().sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

/** Session ids, newest activity first. */
export function sessionIds(events: readonly ExtEvent[]): string[] {
  const last = new Map<string, number>();
  for (const e of attribute(events)) last.set(e.session, Math.max(last.get(e.session) ?? 0, e.ts));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
