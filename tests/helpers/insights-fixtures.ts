// Event builders for the insights tests: hand-made events and the recorded Hermes demo session.
import { validateEvent, type ExtEvent, type ExtEventIn } from "../../src/ext/schema";
import { mapHermes } from "../../src/ext/hermes";
import { hermesDemoScript, stampEnvelope } from "../../src/demo/hermes-session";

export const T0 = Date.UTC(2026, 9, 19, 2, 0, 0); // 09:00 in UTC+7

export function maker(session = "s1", start = T0) {
  let seq = 0, t = start;
  const ev = (e: Omit<ExtEventIn, "session"> & { session?: string }, gapMs = 1000): ExtEvent => {
    t += gapMs;
    const v = validateEvent({ session, ...e, ts: t }, t);
    if (!v.ok) throw new Error(v.error);
    return { ...v.event, seq: ++seq } as ExtEvent;
  };
  return { ev, now: () => t };
}

/** The recorded Hermes demo, mapped and validated exactly like the app plays it. */
export function demoEvents(start = T0): ExtEvent[] {
  const out: ExtEvent[] = [];
  let clock = start, n = 0, seq = 0;
  for (const [delay, env] of hermesDemoScript()) {
    clock += delay;
    for (const raw of mapHermes(stampEnvelope(env, clock, n++), "full")) {
      const v = validateEvent(raw, clock);
      if (v.ok) out.push({ ...v.event, seq: ++seq } as ExtEvent);
    }
  }
  return out;
}
