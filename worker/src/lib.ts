// Pure helpers shared by the Worker and its tests (no Workers runtime imports here).

export const RUN_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
export const MAX_FILES = 80;
export const MAX_TOTAL = 3_000_000;

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts allow-forms",
].join("; ");

export const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", webmanifest: "application/manifest+json", xml: "application/xml", ico: "image/x-icon",
};

export function safePath(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
  if (!s || s.length > 200) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "" || x === "." || /[\x00-\x1f:*?"<>|]/.test(x))) return null;
  if (!/\.(html|htm|css|js|mjs|json|svg|txt|md|webmanifest|xml|ico)$/i.test(s)) return null;
  return s;
}

/** Hosts the proxy and fetcher refuse: loopback, private ranges, link-local, metadata. */
export function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  // public wildcard-DNS names that resolve to the address written in them (127.0.0.1.nip.io, …)
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me)$/.test(h)) return true;
  if (h.includes(":")) {
    if (h === "::" || h === "::1" || /^(fc|fd|fe[89ab])/.test(h)) return true;
    // IPv4-mapped / -compatible / NAT64 addresses carry an IPv4 address: judge that one
    const v4 = h.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const hex = h.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4) h = v4;
    else if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
    else return false;
  }
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|255\.255\.255\.255$)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  const cg = h.match(/^100\.(\d+)\./); // carrier-grade NAT, also used by Tailscale
  if (cg && +cg[1] >= 64 && +cg[1] <= 127) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-ot-base-url, x-ot-gh-token, accept, x-github-api-version",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-expose-headers": "x-ratelimit-remaining, x-ratelimit-reset, retry-after, link",
};

/**
 * The only GitHub API calls the proxy forwards. Reads, plus creating blobs/trees/commits, NEW refs
 * and pull requests. No PATCH/PUT/DELETE at all: the proxy cannot move or force-push a branch,
 * merge, or delete anything, whatever the browser asks.
 */
const GH_ROUTES: [string, RegExp][] = [
  ["GET", /^\/user$/],
  ["GET", /^\/user\/repos$/],
  ["GET", /^\/rate_limit$/],
  ["GET", /^\/repos\/[\w.-]+\/[\w.-]+$/],
  ["GET", /^\/repos\/[\w.-]+\/[\w.-]+\/branches(\/[^?#]+)?$/],
  ["GET", /^\/repos\/[\w.-]+\/[\w.-]+\/git\/(commits|trees|blobs)\/[0-9a-f]{4,64}$/],
  ["GET", /^\/repos\/[\w.-]+\/[\w.-]+\/git\/ref\/heads\/[^?#]+$/],
  ["POST", /^\/repos\/[\w.-]+\/[\w.-]+\/git\/(blobs|trees|commits)$/],
  ["POST", /^\/repos\/[\w.-]+\/[\w.-]+\/git\/refs$/],
  ["POST", /^\/repos\/[\w.-]+\/[\w.-]+\/pulls$/],
];

export function ghRouteAllowed(method: string, path: string): boolean {
  if (path.includes("..")) return false;
  return GH_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** POST /git/refs must create an overtime/… branch, nothing else. */
export function ghBodyAllowed(path: string, body: string): string | null {
  if (!/\/git\/refs$/.test(path)) return null;
  try {
    const b = JSON.parse(body) as { ref?: string; force?: unknown };
    if (b.force !== undefined) return "force is not allowed";
    if (typeof b.ref !== "string" || !/^refs\/heads\/overtime\/[\w.-]+(\/[\w.-]+)*$/.test(b.ref)) return "only refs/heads/overtime/* branches can be created";
  } catch {
    return "invalid JSON";
  }
  return null;
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 200);
  const text = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title, text: text.slice(0, 40_000) };
}

