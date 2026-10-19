// Ops' side effects in site mode: publish a preview to the Worker, or fall back to an in-browser preview.
// (GitHub work lives in engine/github.ts: repo mode opens a pull request, it never pushes to a branch.)

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

export { esc };
