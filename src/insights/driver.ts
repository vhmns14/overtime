// Drives the office scene from a replayed session's reducer state: the same effect → animation
// mapping as the live Hermes view, with a speed factor and a generation counter so seeking drops
// stale walks.

import { ROLES, type Role, type Ticket } from "../engine/types";
import type { Office } from "../office/scene";
import type { Effect, SessionView } from "../ext/office-state";

export class SceneDriver {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private gen = 0;
  private workOff: Partial<Record<Role, number>> = {};

  constructor(private office: Office, private view: () => SessionView | null, private speed: () => number) {}

  /** Drop queued walks and timers (seek, exit). */
  cancel() {
    this.gen++;
    for (const r of ROLES) clearTimeout(this.workOff[r]);
  }

  /** Redraw the office from a state without animation. */
  sync(s: SessionView | null) {
    this.cancel();
    const o = this.office;
    o.reset();
    if (!s) return;
    o.setTickets(s.tickets);
    for (const sa of Object.values(s.subagents)) if (sa.status === "running") o.setTag(sa.desk, s.agents[sa.desk].name);
    for (const r of new Set(Object.values(s.openTools).map((t) => t.role))) o.setWorking(r, true);
    if (s.pending) o.setWaiting(s.pending.role, s.pending.kind === "approval" ? "Waiting for approval in Hermes" : "Waiting for you in Hermes");
  }

  private anim(fn: () => Promise<void>) {
    if (this.queued >= 2) return;
    this.queued++;
    const gen = this.gen;
    this.queue = this.queue.then(() => (gen === this.gen ? fn() : undefined)).catch(() => undefined).finally(() => { this.queued--; });
  }

  effect(f: Effect) {
    const o = this.office;
    const scale = 1 / Math.max(1, this.speed());
    const offLater = (r: Role, ms: number) => {
      clearTimeout(this.workOff[r]);
      this.workOff[r] = window.setTimeout(() => {
        const s = this.view();
        if (!s || !Object.values(s.openTools).some((t) => t.role === r)) o.setWorking(r, false);
      }, Math.max(60, ms * scale));
    };
    const bubble = (ms: number) => Math.max(700, ms * Math.max(0.35, scale));
    switch (f.k) {
      case "work":
        if (f.on) { clearTimeout(this.workOff[f.role]); o.setWorking(f.role, true); if (f.say) o.say(f.role, f.say, "think", bubble(2400)); }
        else offLater(f.role, 1400);
        break;
      case "pulse":
        clearTimeout(this.workOff[f.role]);
        o.setWorking(f.role, true);
        if (f.say) o.say(f.role, f.say, "think", bubble(2200));
        offLater(f.role, 1600);
        break;
      case "say": o.say(f.role, f.text, f.kind ?? "think", bubble(3000)); break;
      case "handoff": this.anim(() => o.meeting(f.from, f.to, f.text)); break;
      case "whiteboard": { const t: Ticket[] = f.tickets; this.anim(() => o.whiteboard(t)); break; }
      case "tickets": o.setTickets(f.tickets); break;
      case "wait": o.setWaiting(f.role, f.text); break;
      case "clear-wait": o.clearWaiting(); break;
      case "tag": o.setTag(f.role, f.text); break;
      case "idle-all": this.gen++; for (const r of ROLES) { clearTimeout(this.workOff[r]); o.setWorking(r, false); } break;
      case "session": break;
    }
  }
}
