// Ops' side effects: publish a preview to the Worker, fall back to an in-browser preview, push to
// GitHub with the user's token (browser → api.github.com directly; the token never touches our Worker).

export async function deployToWorker(runId: string, task: string, files: Record<string, string>): Promise<{ url: string; local: boolean }> {
  if (__PREVIEW__) return { url: "", local: true }; // single-file preview: no network at all
  try {
    const res = await fetch(`/api/runs/${runId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, files }) });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { url: string };
    return { url: data.url, local: false };
  } catch {
    return { url: "", local: true }; // no Worker (offline preview / static hosting): preview renders in-browser
  }
}

export async function fetchRef(url: string, signal: AbortSignal): Promise<string> {
  if (__PREVIEW__) throw new Error("offline preview: no network");
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal });
  const data = (await res.json().catch(() => ({}))) as { text?: string; title?: string; error?: string };
  if (!res.ok || !data.text) throw new Error(data.error ?? `fetch failed (${res.status})`);
  return `${data.title ? `Title: ${data.title}\n\n` : ""}${data.text}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resolve(from: string, ref: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const p of ref.split(/[?#]/)[0].split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") base.pop();
    else base.push(p);
  }
  return base.join("/");
}

/** Builds a single self-contained document for an iframe srcdoc: CSS/JS/SVG inlined, strict CSP. */
export function inlinePreview(files: Record<string, string>, entry = "index.html"): string {
  let html = files[entry] ?? "<!doctype html><title>No index.html</title><p>No index.html yet.</p>";
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    const p = href && resolve(entry, href);
    return p && files[p] !== undefined ? `<style>${files[p].replace(/<\/style/gi, "<\\/style")}</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, a, src, b) => {
    const p = resolve(entry, src);
    return p && files[p] !== undefined ? `<script${a}${b}>${files[p].replace(/<\/script/gi, "<\\/script")}</script>` : tag;
  });
  html = html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (m, pre, src, post) => {
    const p = resolve(entry, src);
    if (p && files[p] !== undefined && p.endsWith(".svg")) return `${pre}data:image/svg+xml;charset=utf-8,${encodeURIComponent(files[p])}${post}`;
    return m;
  });
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${csp}`) : csp + html;
}

export interface GitHubTarget { repo: string; branch: string; token: string }

export async function pushToGitHub(t: GitHubTarget, files: Record<string, string>, message: string): Promise<{ url: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(t.repo)) throw new Error("repo must look like owner/name");
  const api = `https://api.github.com/repos/${t.repo}`;
  const h = { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" };
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await fetch(api + path, { ...init, headers: h });
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path.split("/").slice(0, 3).join("/")}`);
    return (await r.json()) as T;
  };
  let parent: string;
  let created = false;
  try {
    parent = (await call<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(t.branch)}`)).object.sha;
  } catch {
    const repo = await call<{ default_branch: string }>("");
    parent = (await call<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`)).object.sha;
    created = true;
  }
  const commit = await call<{ tree: { sha: string } }>(`/git/commits/${parent}`);
  const tree = await call<{ sha: string }>("/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) }),
  });
  const next = await call<{ sha: string }>("/git/commits", { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) });
  if (created) await call("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${t.branch}`, sha: next.sha }) });
  else await call(`/git/refs/heads/${encodeURIComponent(t.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: next.sha }) });
  return { url: `https://github.com/${t.repo}/tree/${encodeURIComponent(t.branch)}` };
}

export { esc };
