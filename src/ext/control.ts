// Remote control for external-agent offices: remote approvals, tasks sent to Hermes, and the signed
// audit log. Pure helpers shared by the Worker (worker/src/control.ts), the browser
// (src/app/control.ts) and the tests. WebCrypto only.
//
// Trust model
// - Three tokens, three powers: the view token reads, the ingest token (on the Hermes machine)
//   writes events and *reads* decisions/commands, and a control token (one per paired device) is
//   the only thing that can decide an approval or queue a task. The view token never controls.
// - Every decision and command handed to the plugin is HMAC-signed with a key only the office and
//   the plugin know: SHA-256(ingest token), which the office already stores. The plugin checks the
//   signature and that it is bound to *its* request id and the exact command hash before acting.
// - Every control action is appended to a hash-chained audit log signed with the office's own
//   ECDSA P-256 key; anyone with the public key can verify the chain.

import { hmacSha256Hex, sha256Hex, safeEqual } from "./auth";

/** Choices Overtime may send. "always" (permanent allowlist) is deliberately local-only. */
export const REMOTE_CHOICES = ["once", "session", "deny"] as const;
export type RemoteChoice = (typeof REMOTE_CHOICES)[number];

export const COMMAND_KINDS = ["run", "stop"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const LIMITS_CONTROL = {
  promptChars: 4000,
  deviceName: 40,
  maxDevices: 10,
  maxWaitS: 25,
  approvalMaxS: 900,
  commandLeaseMs: 120_000,
  openCommands: 5,
};

export type ApprovalStatus = "pending" | "decided" | "applied" | "stale" | "expired" | "answered_locally" | "timeout";
export type CommandStatus = "queued" | "claimed" | "started" | "completed" | "failed" | "cancelled" | "rejected" | "lost";

export interface ApprovalView {
  id: string;
  session: string;
  surface: string;
  command: string;
  description: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  choice?: RemoteChoice;
  by?: string;
  decidedAt?: number;
  outcome?: string;
}

export interface CommandView {
  id: string;
  kind: CommandKind;
  prompt: string;
  target?: string;
  status: CommandStatus;
  createdAt: number;
  by: string;
  runId?: string;
  error?: string;
  updatedAt: number;
}

export interface AuditEntry {
  seq: number;
  at: number;
  kind: string;
  subject: string;
  detail: string;
  by: string;
  prev: string;
  hash: string;
  sig: string;
}

export interface DeviceView { id: string; name: string; createdAt: number; lastSeen: number; current?: boolean }

export function randomId(prefix: string, bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function controlToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return `ot_ctl_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Device names end up in signed strings and the audit log: keep them to a safe alphabet. */
export function cleanDeviceName(s: unknown): string {
  const t = (typeof s === "string" ? s : "").replace(/[^\w .()·-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS_CONTROL.deviceName);
  return t || "Unnamed device";
}

export function isChoice(s: unknown): s is RemoteChoice {
  return typeof s === "string" && (REMOTE_CHOICES as readonly string[]).includes(s);
}

/** A task prompt: 1..4000 chars, no control characters except newline and tab. */
export function validatePrompt(s: unknown): { ok: true; prompt: string } | { ok: false; error: string } {
  if (typeof s !== "string") return { ok: false, error: "prompt must be a string" };
  const p = s.replace(/\r\n?/g, "\n").trim();
  if (!p) return { ok: false, error: "the prompt is empty" };
  if (p.length > LIMITS_CONTROL.promptChars) return { ok: false, error: `the prompt is longer than ${LIMITS_CONTROL.promptChars} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p)) return { ok: false, error: "the prompt contains control characters" };
  return { ok: true, prompt: p };
}

// ---------- signatures the plugin verifies (HMAC-SHA256, key = sha256(ingest token) hex) ----------

export const decisionString = (office: string, requestId: string, commandSha: string, choice: string, by: string, at: number) =>
  ["v1", "decision", office, requestId, commandSha, choice, cleanDeviceName(by), String(at)].join("|");

export const commandString = (office: string, id: string, kind: string, payloadSha: string, createdAt: number) =>
  ["v1", "command", office, id, kind, payloadSha, String(createdAt)].join("|");

export async function signDecision(ingestHash: string, office: string, requestId: string, commandSha: string, choice: RemoteChoice, by: string, at: number) {
  return hmacSha256Hex(ingestHash, decisionString(office, requestId, commandSha, choice, by, at));
}

export async function signCommand(ingestHash: string, office: string, id: string, kind: CommandKind, payload: string, createdAt: number) {
  return hmacSha256Hex(ingestHash, commandString(office, id, kind, await sha256Hex(payload), createdAt));
}

export async function verifyDecision(ingestToken: string, office: string, d: { request_id: string; command_sha256: string; choice: string; by: string; at: number; sig: string }) {
  const key = await sha256Hex(ingestToken);
  const want = await hmacSha256Hex(key, decisionString(office, d.request_id, d.command_sha256, d.choice, d.by, d.at));
  return safeEqual(want, d.sig);
}

// ---------- the audit log: hash chain + ECDSA P-256 signatures ----------

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export const auditLine = (e: Omit<AuditEntry, "hash" | "sig">) =>
  [e.prev, e.seq, e.at, e.kind, e.subject, e.detail, e.by].map((x) => String(x).replace(/[|\n]/g, " ")).join("|");

export async function auditHash(e: Omit<AuditEntry, "hash" | "sig">): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(auditLine(e))));
}

export async function newAuditKeys(): Promise<{ privateJwk: JsonWebKey; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const publicKey = b64u((await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer);
  return { privateJwk, publicKey };
}

export async function signAudit(privateJwk: JsonWebKey, hash: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, unhex(hash)));
}

/** Verifies the whole chain: every hash recomputes, links to the previous one, and is signed. */
export async function verifyAudit(entries: AuditEntry[], publicKey: string): Promise<{ ok: boolean; checked: number; error?: string }> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", unb64u(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return { ok: false, checked: 0, error: "bad public key" };
  }
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (i > 0 && e.prev !== sorted[i - 1].hash) return { ok: false, checked: i, error: `entry ${e.seq} does not link to ${sorted[i - 1].seq}` };
    const h = await auditHash(e);
    if (h !== e.hash) return { ok: false, checked: i, error: `entry ${e.seq} was modified` };
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(e.sig), unhex(e.hash));
    if (!ok) return { ok: false, checked: i, error: `entry ${e.seq} has a bad signature` };
  }
  return { ok: true, checked: sorted.length };
}

/** Human line for an audit entry (UI). */
export function describeAudit(e: Pick<AuditEntry, "kind" | "detail" | "by">): string {
  const by = e.by && e.by !== "hermes" ? ` · ${e.by}` : e.by === "hermes" ? " · Hermes" : "";
  const map: Record<string, string> = {
    "control.enabled": "Remote control enabled",
    "device.added": "Device paired",
    "device.revoked": "Device removed",
    "policy.changed": "Remote control settings changed",
    "notify.changed": "Notification settings changed",
    "approval.requested": "Approval requested",
    "approval.decided": "Approval answered",
    "approval.applied": "Hermes applied the answer",
    "approval.stale": "Answer arrived too late (already answered)",
    "approval.timeout": "No answer in time: Hermes kept asking locally",
    "approval.answered_locally": "Answered in Hermes itself",
    "approval.expired": "Approval expired",
    "command.queued": "Task queued",
    "command.cancelled": "Task cancelled",
    "command.claimed": "Hermes picked up the task",
    "command.started": "Hermes started the task",
    "command.completed": "Task finished",
    "command.failed": "Task failed",
    "command.rejected": "Hermes refused the task",
    "command.lost": "Task lost (Hermes never confirmed it started)",
  };
  return `${map[e.kind] ?? e.kind}${e.detail ? `: ${e.detail}` : ""}${by}`;
}
