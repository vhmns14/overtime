// Notifications when Hermes needs the user: which events trigger one, quiet hours, dedupe and rate
// limits, and the message text. Pure, so the Worker and the tests share it.

import type { ExtEvent } from "./schema";

export const TRIGGERS = ["approval", "error", "stuck", "finished", "budget"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface NotifySettings {
  enabled: boolean;
  triggers: Record<Trigger, boolean>;
  quiet: { on: boolean; start: string; end: string; tz: string };
  /** minutes without events in a working session before it counts as stuck */
  stuckMinutes: number;
  /** the same dedupe key is sent at most once per this many seconds */
  dedupeS: number;
  /** at most this many notifications per channel per hour */
  maxPerHour: number;
  /** spending limits checked server-side on every batch with model calls (USD, null = none); days and
   *  months follow quiet.tz, the browser's time zone saved with these settings */
  budget: { dailyUsd: number | null; monthlyUsd: number | null };
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: false,
  triggers: { approval: true, error: true, stuck: true, finished: false, budget: true },
  quiet: { on: false, start: "22:00", end: "07:00", tz: "UTC" },
  stuckMinutes: 10,
  dedupeS: 600,
  maxPerHour: 12,
  budget: { dailyUsd: null, monthlyUsd: null },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates and fills a settings object from untrusted input. */
export function parseNotifySettings(x: unknown, base: NotifySettings = DEFAULT_NOTIFY): NotifySettings {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, any>;
  const t = (o.triggers && typeof o.triggers === "object" ? o.triggers : {}) as Record<string, unknown>;
  const q = (o.quiet && typeof o.quiet === "object" ? o.quiet : {}) as Record<string, unknown>;
  const tz = typeof q.tz === "string" && validTz(q.tz) ? q.tz : base.quiet.tz;
  const b = (o.budget && typeof o.budget === "object" ? o.budget : {}) as Record<string, unknown>;
  // a positive number sets a limit, null (or 0) clears it, anything else keeps the old one
  const lim = (v: unknown, d: number | null) => (v === null || v === 0 ? null : typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(1e6, v) : d);
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    triggers: Object.fromEntries(TRIGGERS.map((k) => [k, typeof t[k] === "boolean" ? t[k] : base.triggers[k]])) as Record<Trigger, boolean>,
    quiet: {
      on: typeof q.on === "boolean" ? q.on : base.quiet.on,
      start: typeof q.start === "string" && HHMM.test(q.start) ? q.start : base.quiet.start,
      end: typeof q.end === "string" && HHMM.test(q.end) ? q.end : base.quiet.end,
      tz,
    },
    stuckMinutes: num(o.stuckMinutes, 2, 240, base.stuckMinutes),
    dedupeS: num(o.dedupeS, 30, 86_400, base.dedupeS),
    maxPerHour: num(o.maxPerHour, 1, 60, base.maxPerHour),
    budget: { dailyUsd: lim(b.dailyUsd, base.budget.dailyUsd), monthlyUsd: lim(b.monthlyUsd, base.budget.monthlyUsd) },
  };
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since midnight at `now` in the given time zone. */
export function minutesInTz(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Offset of a time zone at `now` in Date#getTimezoneOffset terms (UTC+7 → -420). */
export function tzOffsetMin(now: number, tz: string): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return -Math.round((wall - Math.floor(now / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** A budget notification when today's or this month's spend is past its limit (key: once per period). */
export function budgetCandidate(spend: { day: number; month: number; dayKey: string; monthKey: string }, budget: NotifySettings["budget"]): Candidate | null {
  const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
  if (budget.dailyUsd !== null && spend.day >= budget.dailyUsd) return { trigger: "budget", key: `budget:day:${spend.dayKey}`, session: "", title: "Daily budget exceeded", body: `Hermes spent ${usd(spend.day)} today (limit ${usd(budget.dailyUsd)}). Overtime only warns; Hermes keeps running.` };
  if (budget.monthlyUsd !== null && spend.month >= budget.monthlyUsd) return { trigger: "budget", key: `budget:month:${spend.monthKey}`, session: "", title: "Monthly budget exceeded", body: `Hermes spent ${usd(spend.month)} this month (limit ${usd(budget.monthlyUsd)}). Overtime only warns; Hermes keeps running.` };
  return null;
}

/** True during quiet hours. A window may cross midnight (22:00 → 07:00). */
export function inQuietHours(s: NotifySettings, now: number): boolean {
  if (!s.quiet.on) return false;
  const toMin = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const a = toMin(s.quiet.start);
  const b = toMin(s.quiet.end);
  if (a === b) return false;
  const m = minutesInTz(now, s.quiet.tz);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export interface Candidate {
  trigger: Trigger;
  /** dedupe key: one notification per key per dedupe window */
  key: string;
  session: string;
  title: string;
  body: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Notifications a batch of stored events could produce (before settings, quiet hours and limits). */
export function candidatesFor(events: ExtEvent[], titleOf: (session: string) => string | undefined = () => undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const e of events) {
    const d = e.data as Record<string, any>;
    const title = titleOf(e.session);
    const where = title ? ` · ${clip(title, 60)}` : "";
    if (e.type === "approval.request") {
      const what = typeof d.description === "string" && d.description ? d.description : "A command needs approval";
      out.push({ trigger: "approval", key: `approval:${e.session}:${d.id ?? d.command ?? e.seq}`, session: e.session, title: "Hermes needs your approval", body: clip(`${what}${d.command ? `: ${d.command}` : ""}`, 180) + where });
    } else if (e.type === "human_input.request") {
      out.push({ trigger: "approval", key: `input:${e.session}:${d.id ?? e.seq}`, session: e.session, title: "Hermes is waiting for you", body: (d.kind === "clarify" ? "Hermes asked you a question" : d.kind === "sudo" ? "Hermes needs your sudo password" : "Hermes is waiting for your input") + where });
    } else if (e.type === "error") {
      out.push({ trigger: "error", key: `error:${e.session}:${clip(String(d.kind ?? d.message ?? "error"), 40)}`, session: e.session, title: "Hermes hit an error", body: clip(String(d.message ?? "error"), 180) + where });
    } else if (e.type === "session.end" && e.agent === "main" && !d.final) {
      if (d.status === "failed") out.push({ trigger: "error", key: `failed:${e.session}`, session: e.session, title: "Hermes failed", body: clip(`The session ended with an error${d.reason ? ` (${d.reason})` : ""}`, 180) + where });
      else if (d.status === "completed") out.push({ trigger: "finished", key: `finished:${e.session}:${Math.floor(e.ts / 60_000)}`, session: e.session, title: "Hermes finished", body: `Done${where || "."}` });
    }
  }
  return out;
}

export interface SentLog { key: string; at: number; channel: string }

/** Decides whether one candidate goes out now on one channel. */
export function shouldSend(c: Candidate, s: NotifySettings, log: SentLog[], channel: string, now: number): { send: true } | { send: false; reason: "disabled" | "trigger-off" | "quiet-hours" | "duplicate" | "rate-limited" } {
  if (!s.enabled) return { send: false, reason: "disabled" };
  if (!s.triggers[c.trigger]) return { send: false, reason: "trigger-off" };
  if (inQuietHours(s, now)) return { send: false, reason: "quiet-hours" };
  if (log.some((l) => l.channel === channel && l.key === c.key && now - l.at < s.dedupeS * 1000)) return { send: false, reason: "duplicate" };
  if (log.filter((l) => l.channel === channel && now - l.at < 3_600_000).length >= s.maxPerHour) return { send: false, reason: "rate-limited" };
  return { send: true };
}

export interface Message { title: string; body: string; url: string; tag: string }

export function toMessage(c: Candidate, watchUrl: string): Message {
  return { title: c.title, body: c.body, url: watchUrl, tag: `${c.trigger}:${c.session}`.slice(0, 64) };
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Telegram sendMessage body (HTML parse mode, every value escaped). */
export function telegramBody(chatId: string, m: Message): Record<string, unknown> {
  const https = /^https:\/\//.test(m.url);
  return {
    chat_id: chatId,
    text: `<b>${escHtml(m.title)}</b>\n${escHtml(m.body)}\n\n<a href="${escHtml(m.url)}">Open in Overtime</a>`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(https ? { reply_markup: { inline_keyboard: [[{ text: "Open in Overtime", url: m.url }]] } } : {}),
  };
}

export const TELEGRAM_TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z]\w{4,31})$/;

/** Web Push endpoints we deliver to: the browser push services, never arbitrary hosts. */
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[\w-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[\w.-]+\.notify\.windows\.com$/];

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}
