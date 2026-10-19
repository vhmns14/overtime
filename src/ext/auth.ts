// Tokens and signatures for external agents. WebCrypto only, so it runs in the Worker, in Node
// (tests) and in the browser alike.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(prefix: "ot_ing" | "ot_view" | "ot_whs", bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${b64url(b)}`;
}

export function newOfficeId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return `of-${b64url(b).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export const OFFICE_ID = /^of-[a-z0-9]{8,24}$/;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison of two strings (the length itself is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hmacSha256Hex(secret: string, body: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = (typeof body === "string" ? enc.encode(body) : body) as Uint8Array<ArrayBuffer>;
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a Hermes outbound-webhook signature: header `X-Hermes-Signature-256: sha256=<hex>`,
 * HMAC-SHA256 of the raw request body with the shared secret (GitHub style; see
 * hermes-agent agent/outbound_webhooks.py `_build_delivery`).
 */
export async function verifyHermesSignature(secret: string, rawBody: string | Uint8Array, header: string | null): Promise<boolean> {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + (await hmacSha256Hex(secret, rawBody));
  return safeEqual(expected, header.trim().toLowerCase());
}

/** Hermes puts `timestamp` (ISO-8601 UTC) inside the signed body; reject stale or far-future deliveries. */
export function freshTimestamp(ts: unknown, now = Date.now(), toleranceMs = 5 * 60_000): boolean {
  if (typeof ts !== "string") return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && Math.abs(now - t) <= toleranceMs;
}

export function bearer(req: { headers: { get(n: string): string | null } }): string {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
}

/** Token bucket used by the office Durable Object for request and event rate limits. */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private capacity: number, private perSecond: number, now = Date.now()) {
    this.tokens = capacity;
    this.at = now;
  }
  take(n = 1, now = Date.now()): { ok: boolean; retryAfterS: number } {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((n - this.tokens) / this.perSecond)) };
  }
}
