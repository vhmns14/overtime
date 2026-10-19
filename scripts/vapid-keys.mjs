#!/usr/bin/env node
// Prints a VAPID key pair for Web Push in the format Overtime reads (base64url, uncompressed P-256
// public point + the private scalar d). Optional: without them each office generates its own pair.
//   node scripts/vapid-keys.mjs            → VAPID_PUBLIC_KEY=… / VAPID_PRIVATE_KEY=…
//   node scripts/vapid-keys.mjs --json
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const b = (s) => Buffer.from(s, "base64url");
const point = Buffer.concat([Buffer.from([4]), b(pub.x), b(pub.y)]).toString("base64url");
const out = { VAPID_PUBLIC_KEY: point, VAPID_PRIVATE_KEY: priv.d };
if (process.argv.includes("--json")) console.log(JSON.stringify(out));
else for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
