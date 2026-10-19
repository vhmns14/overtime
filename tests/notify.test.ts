// Notifications: triggers, quiet hours, dedupe and rate limits (pure), Web Push encryption + VAPID,
// and delivery from the office Durable Object to mocked Telegram and push services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicKey, createVerify } from "node:crypto";
import { handleExt } from "../worker/src/ext";
import { ControlOffice, handleControl, type ControlEnv } from "../worker/src/control";
import { fakeNamespace } from "./helpers/fake-do";
import { DEFAULT_NOTIFY, candidatesFor, inQuietHours, parseNotifySettings, shouldSend, telegramBody, pushEndpointAllowed, type SentLog } from "../src/ext/notify";
import { buildPushRequest, decryptPayload, encryptPayload, generateVapidKeys, vapidJwt, seal, open } from "../src/ext/webpush";
import { b64u, unb64u } from "../src/ext/control";
import type { ExtEvent } from "../src/ext/schema";

const ev = (type: string, data: Record<string, unknown>, session = "s1", extra: Partial<ExtEvent> = {}): ExtEvent => ({ v: 1, seq: 1, type: type as never, ts: Date.parse("2026-10-19T10:00:00Z"), session, agent: "main", data: data as never, ...extra });
const on = { ...DEFAULT_NOTIFY, enabled: true };

describe("triggers", () => {
  it("maps approval waits, errors, failures and finished sessions; ignores subagents and finalize", () => {
    const c = candidatesFor([
      ev("approval.request", { id: "a1", description: "force push", command: "git push --force" }),
      ev("human_input.request", { id: "h1", kind: "clarify" }),
      ev("error", { message: "rate limited by provider", kind: "api" }),
      ev("session.end", { status: "failed", reason: "max_iterations" }),
      ev("session.end", { status: "completed" }),
      ev("session.end", { status: "completed", final: true }),
      ev("session.end", { status: "completed" }, "s1", { agent: "sub1" }),
      ev("tool.start", { name: "terminal" }),
    ]);
    expect(c.map((x) => x.trigger)).toEqual(["approval", "approval", "error", "error", "finished"]);
    expect(c[0]).toMatchObject({ title: "Hermes needs your approval", body: "force push: git push --force" });
  });
});

describe("quiet hours", () => {
  const s = parseNotifySettings({ enabled: true, quiet: { on: true, start: "22:00", end: "07:00", tz: "Asia/Jakarta" } });
  it("crosses midnight in the user's time zone", () => {
    expect(inQuietHours(s, Date.parse("2026-10-19T16:30:00Z"))).toBe(true); // 23:30 WIB
    expect(inQuietHours(s, Date.parse("2026-10-19T23:59:00Z"))).toBe(true); // 06:59 WIB
    expect(inQuietHours(s, Date.parse("2026-10-20T00:00:00Z"))).toBe(false); // 07:00 WIB
    expect(inQuietHours(s, Date.parse("2026-10-19T05:00:00Z"))).toBe(false); // 12:00 WIB
  });
  it("same-day windows and bad input", () => {
    const d = parseNotifySettings({ enabled: true, quiet: { on: true, start: "09:00", end: "17:00", tz: "UTC" } });
    expect(inQuietHours(d, Date.parse("2026-10-19T12:00:00Z"))).toBe(true);
    expect(inQuietHours(d, Date.parse("2026-10-19T18:00:00Z"))).toBe(false);
    const bad = parseNotifySettings({ quiet: { on: true, start: "25:00", end: "x", tz: "Mars/Olympus" }, stuckMinutes: 1e9, maxPerHour: -3 });
    expect(bad.quiet).toEqual({ on: true, start: "22:00", end: "07:00", tz: "UTC" });
    expect(bad.stuckMinutes).toBe(240);
    expect(bad.maxPerHour).toBe(1);
  });
  it("suppresses sending", () => {
    const [c] = candidatesFor([ev("error", { message: "x" })]);
    expect(shouldSend(c, s, [], "telegram", Date.parse("2026-10-19T16:30:00Z"))).toEqual({ send: false, reason: "quiet-hours" });
  });
});

describe("dedupe and rate limits", () => {
  const [c] = candidatesFor([ev("approval.request", { id: "a1", description: "x" })]);
  const t = Date.parse("2026-10-19T10:00:00Z");
  it("sends a key once per dedupe window, per channel", () => {
    const log: SentLog[] = [{ key: c.key, channel: "telegram", at: t - 60_000 }];
    expect(shouldSend(c, on, log, "telegram", t)).toEqual({ send: false, reason: "duplicate" });
    expect(shouldSend(c, on, log, "push", t)).toEqual({ send: true });
    expect(shouldSend(c, on, log, "telegram", t + on.dedupeS * 1000)).toEqual({ send: true });
  });
  it("caps notifications per hour", () => {
    const log: SentLog[] = Array.from({ length: on.maxPerHour }, (_, i) => ({ key: `k${i}`, channel: "push", at: t - i * 1000 }));
    expect(shouldSend(c, on, log, "push", t)).toEqual({ send: false, reason: "rate-limited" });
    expect(shouldSend(c, on, log, "push", t + 3_600_001)).toEqual({ send: true });
  });
  it("respects the master switch and per-trigger toggles", () => {
    expect(shouldSend(c, DEFAULT_NOTIFY, [], "push", t)).toEqual({ send: false, reason: "disabled" });
    expect(shouldSend(c, { ...on, triggers: { ...on.triggers, approval: false } }, [], "push", t)).toEqual({ send: false, reason: "trigger-off" });
  });
});

describe("message bodies", () => {
  it("escapes Telegram HTML and only adds a URL button for https links", () => {
    const b = telegramBody("123", { title: "<b>x</b>", body: "a & b", url: "http://localhost:8787/watch/of-x#v=1", tag: "t" });
    expect(b.text).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(b.text).toContain("a &amp; b");
    expect(b.reply_markup).toBeUndefined();
    expect(telegramBody("1", { title: "t", body: "b", url: "https://o.dev/watch/of-x#v=1", tag: "t" }).reply_markup).toBeTruthy();
  });
  it("only delivers to browser push services", () => {
    expect(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(pushEndpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(pushEndpointAllowed("http://fcm.googleapis.com/x")).toBe(false);
    expect(pushEndpointAllowed("https://169.254.169.254/latest")).toBe(false);
    expect(pushEndpointAllowed("https://evil.example/fcm.googleapis.com")).toBe(false);
  });
});

async function browserSubscription() {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64u(await crypto.subtle.exportKey("raw", ua.publicKey));
  return { ua, auth, sub: { endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint", keys: { p256dh, auth: b64u(auth) } } };
}

describe("Web Push", () => {
  it("aes128gcm round-trips through the receiver's decryption", async () => {
    const { ua, auth, sub } = await browserSubscription();
    const body = await encryptPayload(sub, new TextEncoder().encode('{"title":"hi"}'));
    expect(body.length).toBeGreaterThan(86);
    expect(new TextDecoder().decode(await decryptPayload(body, ua, auth))).toBe('{"title":"hi"}');
  });

  it("matches the RFC 8291 test vector", async () => {
    // RFC 8291 §5: fixed keys and salt
    const imp = async (d: string, x: string, y: string) => ({
      privateKey: await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d, x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("raw", new Uint8Array([4, ...unb64u(x), ...unb64u(y)]), { name: "ECDH", namedCurve: "P-256" }, true, []),
    });
    const asPub = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const as = await imp("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", b64u(asPub.slice(1, 33)), b64u(asPub.slice(33)));
    const uaPub = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const sub = { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: uaPub, auth: "BTBZMqHH6r4Tts7J_aSIgg" } };
    const body = await encryptPayload(sub, new TextEncoder().encode("When I grow up, I want to be a watermelon"), unb64u("DGv6ra1nlYgDCS1FRnbzlw"), as as CryptoKeyPair);
    expect(b64u(body)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("signs a VAPID JWT that verifies with the public key", async () => {
    const k = await generateVapidKeys();
    const jwt = await vapidJwt(k, "https://fcm.googleapis.com", "mailto:me@example.com");
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:me@example.com" });
    const pt = unb64u(k.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pt.slice(1, 33)), y: b64u(pt.slice(33)) }, format: "jwk" });
    const ok = createVerify("SHA256").update(`${h}.${c}`).verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    const req = await buildPushRequest((await browserSubscription()).sub, { title: "x" }, k, "mailto:me@example.com");
    expect((req.init.headers as Record<string, string>).authorization).toMatch(/^vapid t=.+, k=/);
    expect((req.init.headers as Record<string, string>)["content-encoding"]).toBe("aes128gcm");
  });

  it("seals settings at rest", async () => {
    const s = await seal("master", "telegram:of-1", "123456:secret");
    expect(s).not.toContain("secret");
    expect(await open("master", "telegram:of-1", s)).toBe("123456:secret");
    expect(await open("other", "telegram:of-1", s)).toBeNull();
    expect(await open("master", "telegram:of-2", s)).toBeNull();
  });
});

// ---------- delivery from the office ----------

let env: ControlEnv;
let ns: ReturnType<typeof fakeNamespace<ControlOffice>>;
const ORIGIN = "https://overtime.test";
const TG = "123456789:AAH-fake_fake_fake_fake_fake_fake_xyz";
let sent: { url: string; body: unknown; headers: Record<string, string> }[] = [];
let ipn = 0;

beforeEach(() => {
  ns = fakeNamespace((ctx) => new ControlOffice(ctx as never, env));
  env = { EXT_OFFICES: ns as never, EXT_TTL_DAYS: "30", TELEGRAM_API_BASE: "https://tg.mock" };
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: init.body instanceof Uint8Array ? init.body : JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response("{}", { status: String(url).includes("gone") ? 410 : 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": `10.7.0.${++ipn % 250}` };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const url = new URL(ORIGIN + path);
  const res = (await handleControl(req, env, url)) ?? (await handleExt(req, env, url))!;
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
}

async function setup(settings: Record<string, unknown> = {}) {
  const o = (await call("POST", "/api/ext/runs", { agent: "hermes" })).json as { runId: string; ingestToken: string; viewToken: string };
  const ctl = (await call("POST", `/api/ext/runs/${o.runId}/control/enable`, { device: "Phone" }, o.ingestToken)).json.controlToken as string;
  const base = `/api/ext/runs/${o.runId}/control`;
  const r = await call("POST", `${base}/notify`, { settings: { enabled: true, ...settings }, telegram: { token: TG, chatId: "987654321" } }, ctl);
  expect(r.status).toBe(200);
  const obj = ns.objs.get(o.runId)!;
  const post = async (events: unknown[]) => { await call("POST", `/api/ext/runs/${o.runId}/events`, events, o.ingestToken); await Promise.all(obj.outbox.splice(0)); };
  return { ...o, ctl, base, obj, post };
}

describe("delivery", () => {
  it("validates the Telegram token and chat, stores the token encrypted and never returns it", async () => {
    const o = await setup();
    expect((await call("POST", `${o.base}/notify`, { telegram: { token: "nope", chatId: "1" } }, o.ctl)).status).toBe(400);
    expect((await call("POST", `${o.base}/notify`, { telegram: { token: TG, chatId: "drop table" } }, o.ctl)).status).toBe(400);
    const st = await call("GET", `${o.base}/state`, undefined, o.ctl);
    expect(st.json.telegram).toEqual({ set: true, chatId: "987654321", tokenTail: "_xyz" });
    expect(JSON.stringify(st.json)).not.toContain(TG);
    const raw = (o.obj as any).ctx.storage.sql.exec("SELECT v FROM ctl_kv WHERE k = 'telegram'").toArray()[0].v as string;
    expect(raw).not.toContain("AAH-fake");
  });

  it("sends an approval wait to Telegram with a deep link to /watch, once", async () => {
    const o = await setup();
    const approval = { type: "approval.request", session: "s1", data: { id: "ap1", description: "force push", command: "git push --force" } };
    await o.post([approval]);
    await o.post([{ ...approval, id: "dup-x" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://tg.mock/bot${TG}/sendMessage`);
    const body = sent[0].body as { chat_id: string; text: string };
    expect(body.chat_id).toBe("987654321");
    expect(body.text).toContain("Hermes needs your approval");
    expect(body.text).toContain(`${ORIGIN}/watch/${o.runId}#v=${o.viewToken}`);
  });

  it("honours per-trigger toggles and quiet hours", async () => {
    const o = await setup({ triggers: { approval: true, error: false, stuck: false, finished: true } });
    await o.post([{ type: "error", session: "s1", data: { message: "boom" } }]);
    expect(sent).toHaveLength(0);
    await o.post([{ type: "session.end", session: "s1", data: { status: "completed" } }]);
    expect(sent).toHaveLength(1);
    const q = await setup({ quiet: { on: true, start: "00:00", end: "23:59", tz: "UTC" } });
    sent = [];
    await q.post([{ type: "approval.request", session: "s1", data: { id: "x", description: "y" } }]);
    expect(sent).toHaveLength(0);
  });

  it("delivers encrypted Web Push to subscribed devices and drops gone subscriptions", async () => {
    const o = await setup();
    await call("POST", `${o.base}/notify`, { telegram: { clear: true } }, o.ctl);
    const { ua, auth, sub } = await browserSubscription();
    expect((await call("POST", `${o.base}/push/subscribe`, { subscription: { ...sub, endpoint: "https://evil.example/x" } }, o.ctl)).status).toBe(400);
    expect((await call("POST", `${o.base}/push/subscribe`, { subscription: sub }, o.ctl)).status).toBe(201);
    const st = await call("GET", `${o.base}/state`, undefined, o.ctl);
    expect(st.json.push.vapidPublicKey).toMatch(/^B[\w-]{80,}$/);
    await o.post([{ type: "approval.request", session: "s1", data: { id: "a", description: "rm -rf build" } }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(sub.endpoint);
    expect(sent[0].headers.authorization).toContain(`k=${st.json.push.vapidPublicKey}`);
    const msg = JSON.parse(new TextDecoder().decode(await decryptPayload(sent[0].body as Uint8Array, ua, auth)));
    expect(msg).toMatchObject({ title: "Hermes needs your approval", url: `${ORIGIN}/watch/${o.runId}#v=${o.viewToken}` });
    // a 410 from the push service removes the subscription
    const gone = { ...sub, endpoint: "https://fcm.googleapis.com/fcm/send/gone" };
    await call("POST", `${o.base}/push/subscribe`, { subscription: gone }, o.ctl);
    await o.post([{ type: "error", session: "s2", data: { message: "x" } }]);
    expect((await call("GET", `${o.base}/state`, undefined, o.ctl)).json.push.subscriptions).toBe(1);
  });

  it("test notifications bypass dedupe and report per channel", async () => {
    const o = await setup();
    const r = await call("POST", `${o.base}/notify/test`, {}, o.ctl);
    expect(r.json.results).toEqual([{ channel: "telegram", ok: true, status: 200 }]);
    expect((await call("POST", `${o.base}/notify/test`, {}, o.viewToken)).status).toBe(401);
  });

  it("flags a working session that goes quiet as stuck, once, via the Durable Object alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const o = await setup({ stuckMinutes: 5 });
      await o.post([{ type: "tool.start", session: "s9", data: { name: "terminal" } }]);
      const alarmAt = (o.obj as any).ctx.alarm as number;
      expect(alarmAt - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(alarmAt - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
      vi.setSystemTime(alarmAt + 1);
      await o.obj.alarm();
      expect(sent.map((s) => (s.body as { text: string }).text.split("\n")[0])).toEqual(["<b>Hermes looks stuck</b>"]);
      await o.obj.alarm();
      expect(sent).toHaveLength(1);
      // the office still expires on schedule
      expect((o.obj as any).ctx.alarm).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
