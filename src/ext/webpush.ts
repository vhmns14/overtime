// Web Push without dependencies: VAPID (RFC 8292, ES256 JWT) and message encryption with
// aes128gcm (RFC 8291 + RFC 8188). WebCrypto only, so it runs in the Worker and in Node (tests).

import { b64u, unb64u } from "./control";

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }
export interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }

/** A new VAPID key pair: the public key as the uncompressed point (base64url) browsers want. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { publicKey: b64u(raw), privateJwk: (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey };
}

/** VAPID from a Worker secret: VAPID_PRIVATE_KEY (base64url "d") + VAPID_PUBLIC_KEY (base64url raw point). */
export function vapidFromEnv(publicKey?: string, privateKey?: string): VapidKeys | null {
  if (!publicKey || !privateKey) return null;
  const pt = unb64u(publicKey);
  if (pt.length !== 65 || pt[0] !== 4) return null;
  return { publicKey, privateJwk: { kty: "EC", crv: "P-256", x: b64u(pt.slice(1, 33)), y: b64u(pt.slice(33, 65)), d: privateKey, ext: true } };
}

export async function vapidJwt(keys: VapidKeys, audience: string, subject: string, now = Date.now()): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(sig)}`;
}

/** Encrypts one record for a subscription (aes128gcm, RFC 8291). */
export async function encryptPayload(sub: PushSubscriptionJSON, plaintext: Uint8Array, salt?: Uint8Array, asKeys?: CryptoKeyPair): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad subscription keys");
  const as = asKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as never, as.privateKey, 256));
  // IKM = HKDF(auth_secret, shared, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(s, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = cat(plaintext, new Uint8Array([2])); // single, last record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(padded)));
  const rs = 4096;
  const header = cat(s, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic);
  return cat(header, ct);
}

/** The fetch() arguments for one push message. */
export async function buildPushRequest(sub: PushSubscriptionJSON, payload: unknown, keys: VapidKeys, subject: string, opts: { ttl?: number; urgency?: "normal" | "high"; topic?: string } = {}) {
  const u = new URL(sub.endpoint);
  const jwt = await vapidJwt(keys, `${u.protocol}//${u.host}`, subject);
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(opts.ttl ?? 3600),
    urgency: opts.urgency ?? "high",
  };
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return { url: sub.endpoint, init: { method: "POST", headers, body } as RequestInit };
}

/** Receiver side (what the browser does), used by the tests to prove the encryption round-trips. */
export async function decryptPayload(body: Uint8Array, uaKeys: CryptoKeyPair, authSecret: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", uaKeys.publicKey)) as ArrayBuffer);
  const asKey = await crypto.subtle.importKey("raw", buf(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, uaKeys.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(ct)));
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  if (pt[end] !== 2) throw new Error("bad padding delimiter");
  return pt.slice(0, end);
}

// ---------- a small secret box for settings at rest (AES-GCM, key from HKDF) ----------

async function boxKey(master: string, context: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(master), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("overtime-secretbox-v1"), info: enc.encode(context) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(master: string, context: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await boxKey(master, context), enc.encode(plaintext));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

export async function open(master: string, context: string, sealed: string): Promise<string | null> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(unb64u(iv)) }, await boxKey(master, context), buf(unb64u(ct)));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
