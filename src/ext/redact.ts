// Redaction of anything that looks like a secret, applied to every external event before it is
// stored or streamed. Conservative on purpose: a false positive costs a "[redacted]" in the log,
// a false negative leaks a key into a shareable viewer.

export const REDACTED = "[redacted]";

/** Value patterns: provider keys, VCS tokens, cloud keys, JWTs, bearer headers, PEM blocks, our own tokens. */
const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:or-v1-|ant-(?:api\d+-)?|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, OpenRouter, Anthropic, Stripe-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bot_(?:ing|view|whs|ctl)_[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // key=value / "key": "value" / KEY: value assignments of secret-looking names
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PRIVATE_?KEY|CLIENT_?SECRET)[A-Za-z0-9_]*)(\s*[=:]\s*["']?)([^\s"'&,;]{4,})/gi,
  // credentials inside URLs: scheme://user:pass@host
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi,
];

/** Object keys whose values are always dropped (exact names, case-insensitive, `_`/`-` agnostic). */
const KEY_RE = /^(?:.*[_-])?(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|authorization|cookie|set[_-]?cookie|private[_-]?key|credentials?|client[_-]?secret|session[_-]?token)$/i;

export function isSensitiveKey(k: string): boolean {
  return KEY_RE.test(k);
}

export function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (...m: string[]) => {
      // assignment pattern: keep the name, drop the value
      if (m.length >= 6 && m[3] === "@") return `${m[1]}${REDACTED}@`;
      if (m.length >= 6 && typeof m[2] === "string" && typeof m[3] === "string" && /[=:]/.test(m[2])) return `${m[1]}${m[2]}${REDACTED}`;
      if (/^(Bearer|Basic|token)\s/i.test(m[0])) return `${m[0].split(/\s+/)[0]} ${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

export function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = isSensitiveKey(k) ? REDACTED : redactDeep(x, depth + 1);
    return out;
  }
  return v;
}
