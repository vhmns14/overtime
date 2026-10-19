// Overtime Worker: serves the app (Workers Static Assets), a stateless LLM proxy that forwards the
// user's own key without storing or logging it, a read-only page fetcher for Research, and preview
// hosting at /p/<runId>/ backed by one SQLite Durable Object per run, and external-agent offices
// (Hermes first) at /api/ext/* backed by one SQLite Durable Object per office (worker/src/ext.ts).

export interface Env {
  ASSETS: Fetcher;
  PREVIEWS: DurableObjectNamespace;
  /** "1" lets the proxy reach http://localhost (wrangler dev only) */
  ALLOW_LOCAL_LLM?: string;
  PREVIEW_TTL_DAYS?: string;
  EXT_OFFICES: DurableObjectNamespace;
  EXT_TTL_DAYS?: string;
  /** buildings: one per group of Hermes installs, indexing their offices as floors (worker/src/building.ts) */
  EXT_BUILDINGS: DurableObjectNamespace;
}

import { DurableObject } from "cloudflare:workers";
import { handleExt } from "./ext";
export { ExtOffice } from "./ext";
import { handleBuilding } from "./building";
export { ExtBuilding } from "./building";
import { RUN_ID, MAX_FILES, MAX_TOTAL, PREVIEW_CSP, TYPES, safePath, isPrivateHost, json, CORS, htmlToText, ghRouteAllowed, ghBodyAllowed } from "./lib";

async function proxyLLM(req: Request, env: Env): Promise<Response> {
  const base = req.headers.get("x-ot-base-url") ?? "";
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return json({ error: "x-ot-base-url must be an absolute URL" }, 400, CORS);
  }
  const local = env.ALLOW_LOCAL_LLM === "1" && u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (!local && (u.protocol !== "https:" || isPrivateHost(u.hostname))) return json({ error: "base URL must be a public https endpoint" }, 400, CORS);
  const body = await req.text();
  if (body.length > 1_500_000) return json({ error: "request too large" }, 413, CORS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers.get("authorization");
  if (auth) headers.authorization = auth; // forwarded as-is, never stored, never logged
  if (u.hostname.endsWith("openrouter.ai")) { headers["http-referer"] = "https://github.com/vhmns14/overtime"; headers["x-title"] = "Overtime"; }
  const upstream = await fetch(u.toString().replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers, body });
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...CORS } });
}

/**
 * Stateless GitHub API proxy. The token arrives in x-ot-gh-token on each request, is forwarded as
 * Authorization to api.github.com and dropped. It is never stored and nothing here logs it.
 */
async function proxyGitHub(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice("/api/gh".length) || "/";
  const method = req.method.toUpperCase();
  if (!ghRouteAllowed(method, path)) return json({ message: `Overtime's GitHub proxy does not forward ${method} ${path.split("/").slice(0, 2).join("/")}…` }, 403, CORS);
  const token = req.headers.get("x-ot-gh-token") ?? "";
  if (!token) return json({ message: "missing GitHub token" }, 401, CORS);
  if (!/^[\w-]{20,255}$/.test(token)) return json({ message: "malformed GitHub token" }, 401, CORS);
  let body: string | undefined;
  if (method === "POST") {
    body = await req.text();
    if (body.length > 8_000_000) return json({ message: "request too large" }, 413, CORS);
    const bad = ghBodyAllowed(path, body);
    if (bad) return json({ message: bad }, 403, CORS);
  }
  const upstream = await fetch(`https://api.github.com${path}${url.search}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Overtime (+https://github.com/vhmns14/overtime)",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...CORS };
  for (const h of ["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "link"]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function fetchPage(url: string): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return json({ error: "invalid url" }, 400);
  }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return json({ error: "only public http(s) pages can be fetched" }, 400);
  const res = await fetch(u.toString(), { headers: { "user-agent": "OvertimeResearch/0.1 (+https://github.com/vhmns14/overtime)", accept: "text/html,text/plain;q=0.9" }, redirect: "follow" });
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/(html|plain)|application\/xhtml/.test(type)) return json({ error: `unsupported content-type ${type}` }, 415);
  const reader = res.body!.getReader();
  let raw = "";
  const dec = new TextDecoder();
  for (let total = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    raw += dec.decode(value, { stream: true });
    if (total > 1_000_000) { await reader.cancel(); break; }
  }
  const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: "", text: raw.slice(0, 40_000) };
  return json({ url: u.toString(), title, text });
}

interface PreviewRPC {
  put(id: string, task: string, files: Record<string, string>, ttlDays: number): Promise<unknown>;
  get(path: string): Promise<string | null>;
  meta(): Promise<unknown>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "OPTIONS" && path.startsWith("/api/") && !path.startsWith("/api/ext/")) return new Response(null, { status: 204, headers: CORS });
    try {
      if (path === "/api/health") return json({ ok: true, service: "overtime", previews: true, ext: true });
      if (path.startsWith("/api/ext/buildings")) return (await handleBuilding(req, env, url))!;
      if (path.startsWith("/api/ext/")) return (await handleExt(req, env, url))!;
      if (path === "/api/llm" && req.method === "POST") return await proxyLLM(req, env);
      if (path.startsWith("/api/gh/")) return await proxyGitHub(req, url);
      if (path === "/api/fetch" && req.method === "GET") return await fetchPage(url.searchParams.get("url") ?? "");
      const run = path.match(/^\/api\/runs\/([^/]+)$/);
      if (run) {
        const id = run[1];
        if (!RUN_ID.test(id)) return json({ error: "invalid run id" }, 400);
        const stub = env.PREVIEWS.get(env.PREVIEWS.idFromName(id)) as unknown as PreviewRPC;
        if (req.method === "PUT") {
          let body: { task?: string; files?: Record<string, string> };
          try {
            body = await req.json();
          } catch {
            return json({ error: "invalid JSON" }, 400);
          }
          const files: Record<string, string> = {};
          let total = 0;
          for (const [p, c] of Object.entries(body.files ?? {})) {
            const sp = safePath(p);
            if (!sp || typeof c !== "string") return json({ error: `invalid file ${p}` }, 400);
            files[sp] = c;
            total += c.length;
          }
          const n = Object.keys(files).length;
          if (!n || n > MAX_FILES || total > MAX_TOTAL) return json({ error: "too many files or too large" }, 413);
          if (!files["index.html"]) return json({ error: "index.html is required" }, 400);
          await stub.put(id, String(body.task ?? "").slice(0, 300), files, Number(env.PREVIEW_TTL_DAYS ?? 7));
          return json({ ok: true, url: `/p/${id}/`, files: n });
        }
        if (req.method === "GET") return json(await stub.meta());
        return json({ error: "method not allowed" }, 405);
      }
      const p = path.match(/^\/p\/([^/]+)(\/.*)?$/);
      if (p) {
        const id = p[1];
        if (!RUN_ID.test(id)) return new Response("Not found", { status: 404 });
        if (!p[2]) return Response.redirect(new URL(`/p/${id}/`, url).toString(), 301);
        let file = decodeURIComponent(p[2].slice(1));
        if (file === "" || file.endsWith("/")) file += "index.html";
        const sp = safePath(file);
        const stub = env.PREVIEWS.get(env.PREVIEWS.idFromName(id)) as unknown as PreviewRPC;
        const content = sp ? await stub.get(sp) : null;
        const headers = {
          "content-security-policy": PREVIEW_CSP,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
        };
        if (content === null) return new Response("Not found", { status: 404, headers: { ...headers, "content-type": "text/plain" } });
        const ext = sp!.split(".").pop()!.toLowerCase();
        return new Response(content, { headers: { ...headers, "content-type": TYPES[ext] ?? "text/plain; charset=utf-8" } });
      }
      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      // never echo request headers or bodies: they may carry the user's key
      return json({ error: "internal error", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export class PreviewStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    });
  }

  async put(id: string, task: string, files: Record<string, string>, ttlDays: number) {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM files");
    for (const [p, c] of Object.entries(files)) sql.exec("INSERT INTO files (path, content) VALUES (?, ?)", p, c);
    const meta = { id, task, files: Object.keys(files).length, bytes: Object.values(files).reduce((n, c) => n + c.length, 0), updatedAt: Date.now() };
    sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('run', ?)", JSON.stringify(meta));
    await this.ctx.storage.setAlarm(Date.now() + Math.max(1, ttlDays) * 86_400_000);
    return meta;
  }

  async get(path: string): Promise<string | null> {
    const rows = this.ctx.storage.sql.exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path).toArray();
    return rows.length ? rows[0].content : null;
  }

  async meta() {
    const rows = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'run'").toArray();
    const files = this.ctx.storage.sql.exec<{ path: string }>("SELECT path FROM files ORDER BY path").toArray().map((r) => r.path);
    return rows.length ? { ...JSON.parse(rows[0].v), paths: files } : { files: 0, paths: [] };
  }

  async alarm() {
    await this.ctx.storage.deleteAll(); // previews expire
  }
}
