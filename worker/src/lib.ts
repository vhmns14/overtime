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
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^(::1|fc|fd|fe80)/.test(h) && h.includes(":")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

export const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-ot-base-url", "access-control-allow-methods": "POST, GET, OPTIONS" };

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

