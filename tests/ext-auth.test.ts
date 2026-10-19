import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHermesSignature, hmacSha256Hex, freshTimestamp, TokenBucket, randomToken, newOfficeId, OFFICE_ID, sha256Hex, safeEqual, bearer } from "../src/ext/auth";

// Hermes signs exactly like this (agent/outbound_webhooks.py _build_delivery):
//   digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
//   headers["X-Hermes-Signature-256"] = f"sha256={digest}"
const hermesSign = (secret: string, body: string) => "sha256=" + createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(body, "utf8")).digest("hex");

describe("Hermes outbound-webhook HMAC", () => {
  const secret = "ot_whs_7Yb2k1n0p9QxZr4TfW3aLmC8";
  const body = JSON.stringify({ hook_event_name: "post_tool_call", profile: "default", tool_name: "terminal", tool_input: { command: "ls" }, session_id: "s", cwd: "/", extra: { status: "ok" }, delivery_id: "d1", timestamp: "2026-10-19T09:00:00Z" });

  it("accepts the signature Hermes produces", async () => {
    expect(await verifyHermesSignature(secret, body, hermesSign(secret, body))).toBe(true);
    expect(await hmacSha256Hex(secret, body)).toBe(hermesSign(secret, body).slice(7));
  });

  it("handles non-ASCII bodies byte-for-byte (Hermes sends ensure_ascii=False UTF-8)", async () => {
    const b = JSON.stringify({ hook_event_name: "post_llm_call", extra: { assistant_response: "Selesai ✓ — kopi ☕" } });
    expect(await verifyHermesSignature(secret, b, hermesSign(secret, b))).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, missing or malformed headers", async () => {
    const sig = hermesSign(secret, body);
    expect(await verifyHermesSignature(secret, body + " ", sig)).toBe(false);
    expect(await verifyHermesSignature("other", body, sig)).toBe(false);
    expect(await verifyHermesSignature(secret, body, null)).toBe(false);
    expect(await verifyHermesSignature(secret, body, sig.slice(7))).toBe(false);
    expect(await verifyHermesSignature(secret, body, "sha1=" + sig.slice(7))).toBe(false);
    expect(await verifyHermesSignature("", body, sig)).toBe(false);
  });

  it("replay window: the signed timestamp must be within 5 minutes", () => {
    const now = Date.parse("2026-10-19T09:00:00Z");
    expect(freshTimestamp("2026-10-19T08:57:00Z", now)).toBe(true);
    expect(freshTimestamp("2026-10-19T08:50:00Z", now)).toBe(false);
    expect(freshTimestamp("2026-10-19T09:10:00Z", now)).toBe(false);
    expect(freshTimestamp(undefined, now)).toBe(false);
  });
});

describe("tokens", () => {
  it("are prefixed, random and url-safe; office ids match the route pattern", async () => {
    const a = randomToken("ot_ing"), b = randomToken("ot_ing");
    expect(a).toMatch(/^ot_ing_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
    for (let i = 0; i < 50; i++) expect(newOfficeId()).toMatch(OFFICE_ID);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(bearer({ headers: new Headers({ authorization: "Bearer ot_ing_x" }) })).toBe("ot_ing_x");
    expect(bearer({ headers: new Headers({ authorization: "Basic x" }) })).toBe("");
  });
});

describe("rate limiting (token bucket)", () => {
  it("allows a burst, then refuses with a retry-after, then refills", () => {
    const t0 = 1_000_000;
    const b = new TokenBucket(5, 1, t0);
    for (let i = 0; i < 5; i++) expect(b.take(1, t0).ok).toBe(true);
    const no = b.take(1, t0);
    expect(no.ok).toBe(false);
    expect(no.retryAfterS).toBe(1);
    expect(b.take(1, t0 + 1100).ok).toBe(true);
    expect(b.take(10, t0 + 1100)).toMatchObject({ ok: false });
  });
});
