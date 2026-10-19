// Repo mode's virtual working tree. The base is a GitHub tree (paths + blob shas); file contents are
// fetched lazily and cached. Agents' writes, patches and deletions are staged on top and never touch
// GitHub until Ops opens the pull request.

import { unifiedDiff, fileDiff, diffStats } from "./diff";
import type { GitHubClient, TreeEntry } from "./github";

export interface RepoFile { path: string; sha: string; size: number }
export interface RepoSource {
  /** returns the text of a base file */
  read(path: string, sha: string): Promise<string>;
}

export const LIMITS = {
  maxEntries: 3000,
  maxFileBytes: 400_000, // larger files are listed but never fetched
  maxReadChars: 24_000, // a single read_file result (≈6k tokens)
  readmeChars: 4_000,
  pmContextChars: 20_000,
};

const IGNORED_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|vendor|target|__pycache__|\.venv|venv|bower_components)(\/|$)/;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|Pipfile\.lock|uv\.lock)$/;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|a|o|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|webm|ogg|wav|flac|sqlite|db|pyc|node|map|min\.js|min\.css)$/i;

export function isLockfile(path: string) { return LOCKFILES.test(path); }

/** Why a tree entry is left out of the agents' view, or null when it is kept. */
export function ignoreReason(path: string, size = 0): string | null {
  if (IGNORED_DIRS.test(path)) return "build/vendor directory";
  if (LOCKFILES.test(path)) return "lockfile";
  if (BINARY.test(path)) return "binary";
  if (size > LIMITS.maxFileBytes) return "too large";
  return null;
}

export interface RepoSnapshot {
  repo: string;
  branch: string;
  sha: string;
  files: RepoFile[];
  ignored: { count: number; reasons: Record<string, number> };
  truncated: boolean;
}

export async function loadSnapshot(gh: GitHubClient, repo: string, branch: string): Promise<RepoSnapshot> {
  const b = await gh.getBranch(repo, branch);
  const commit = await gh.getCommit(repo, b.sha);
  const tree = await gh.getTree(repo, commit.tree.sha);
  return snapshotFromTree(repo, branch, b.sha, tree.tree, tree.truncated);
}

export function snapshotFromTree(repo: string, branch: string, sha: string, entries: TreeEntry[], truncated = false): RepoSnapshot {
  const reasons: Record<string, number> = {};
  const files: RepoFile[] = [];
  let ignored = 0;
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const why = ignoreReason(e.path, e.size ?? 0);
    if (why) { ignored++; reasons[why] = (reasons[why] ?? 0) + 1; continue; }
    if (files.length >= LIMITS.maxEntries) { ignored++; reasons["entry cap"] = (reasons["entry cap"] ?? 0) + 1; continue; }
    files.push({ path: e.path, sha: e.sha, size: e.size ?? 0 });
  }
  files.sort((a, z) => (a.path < z.path ? -1 : a.path > z.path ? 1 : 0));
  return { repo, branch, sha, files, ignored: { count: ignored, reasons }, truncated };
}

/** Normalises a repo-relative path; refuses escapes and the .git dir. */
export function repoPath(p: string): string | null {
  const s = String(p).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
  if (!s || s.length > 300) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "" || x === "." || /[\x00-\x1f]/.test(x))) return null;
  if (parts[0] === ".git") return null;
  return s;
}

export interface Edit { search: string; replace: string; all?: boolean }
export type EditResult = { ok: true; content: string; applied: number } | { ok: false; error: string };

/** Applies search/replace edits in order; every search must match (exactly once unless `all`). Nothing is applied if any edit fails. */
export function applyEdits(content: string, edits: Edit[]): EditResult {
  let out = content;
  let applied = 0;
  for (const [i, e] of edits.entries()) {
    if (typeof e?.search !== "string" || typeof e?.replace !== "string") return { ok: false, error: `edit ${i + 1}: needs "search" and "replace" strings` };
    if (!e.search) return { ok: false, error: `edit ${i + 1}: "search" is empty` };
    const count = out.split(e.search).length - 1;
    if (count === 0) {
      const hint = out.includes(e.search.trim()) ? " (it matches once you trim whitespace: copy the exact indentation)" : "";
      return { ok: false, error: `edit ${i + 1}: search text not found${hint}. Read the file again and copy the exact lines.` };
    }
    if (count > 1 && !e.all) return { ok: false, error: `edit ${i + 1}: search text matches ${count} times; include more surrounding lines so it is unique (or set "all": true)` };
    out = e.all ? out.split(e.search).join(e.replace) : out.replace(e.search, () => e.replace);
    applied++;
  }
  return { ok: true, content: out, applied };
}

/** Head, outline and tail of a large file, so it fits a context budget. */
export function summarizeFile(path: string, text: string, maxChars = LIMITS.maxReadChars): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const outline = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*(export\s|function\s|class\s|async function|def\s|interface\s|type\s|const\s+\w+\s*=\s*(async\s*)?\(|#{1,3}\s)/.test(l))
    .slice(0, 80)
    .map(({ l, i }) => `${i + 1}: ${l.trim().slice(0, 140)}`);
  const budget = Math.max(2000, Math.floor((maxChars - outline.join("\n").length) / 2));
  const head = text.slice(0, budget);
  const tail = text.slice(-Math.floor(budget / 2));
  return `[${path} is ${text.length} chars / ${lines.length} lines; showing head, outline and tail. Use read_file with start_line/end_line for a range.]\n${head}\n…\n[outline]\n${outline.join("\n")}\n…\n${tail}`;
}

export interface FileChange { path: string; status: "added" | "modified" | "deleted"; before?: string; after?: string; added: number; removed: number }

export class RepoFS {
  private base = new Map<string, RepoFile>();
  private cache = new Map<string, string>();
  private staged = new Map<string, string | null>();
  private inflight = new Map<string, Promise<string>>();
  fetched = 0;

  constructor(readonly snapshot: RepoSnapshot, private source: RepoSource) {
    for (const f of snapshot.files) this.base.set(f.path, f);
  }

  has(path: string) {
    if (this.staged.has(path)) return this.staged.get(path) !== null;
    return this.base.has(path);
  }
  inBase(path: string) { return this.base.has(path); }

  paths(): string[] {
    const s = new Set(this.base.keys());
    for (const [p, v] of this.staged) v === null ? s.delete(p) : s.add(p);
    return [...s].sort();
  }

  size(path: string) {
    const st = this.staged.get(path);
    if (typeof st === "string") return st.length;
    return this.base.get(path)?.size ?? 0;
  }

  /** Base content (fetched once, cached). */
  async baseText(path: string): Promise<string> {
    const f = this.base.get(path);
    if (!f) throw new Error(`${path} is not in the base tree`);
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    let p = this.inflight.get(path);
    if (!p) {
      p = this.source.read(path, f.sha).then((t) => { this.cache.set(path, t); this.fetched++; this.inflight.delete(path); return t; });
      this.inflight.set(path, p);
    }
    return p;
  }

  async read(path: string): Promise<string | null> {
    if (this.staged.has(path)) return this.staged.get(path) ?? null;
    if (!this.base.has(path)) return null;
    return this.baseText(path);
  }

  /** Content without fetching (null when not fetched yet). */
  peek(path: string): string | null {
    if (this.staged.has(path)) return this.staged.get(path) ?? null;
    return this.cache.get(path) ?? null;
  }

  write(path: string, content: string) { this.staged.set(path, content); }

  delete(path: string) {
    if (this.base.has(path)) this.staged.set(path, null);
    else this.staged.delete(path);
  }

  async edit(path: string, edits: Edit[]): Promise<EditResult> {
    const cur = await this.read(path);
    if (cur === null) return { ok: false, error: `${path} does not exist` };
    const r = applyEdits(cur, edits);
    if (r.ok) this.staged.set(path, r.content);
    return r;
  }

  /** grep over paths and over every file whose content is known (fetched or staged). */
  search(query: string, opts: { regex?: boolean; max?: number } = {}) {
    const max = opts.max ?? 40;
    let re: RegExp;
    try {
      re = opts.regex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      return { pathMatches: [], contentMatches: [], searched: 0, error: "invalid regex" };
    }
    const pathMatches = this.paths().filter((p) => re.test(p)).slice(0, max);
    const contentMatches: { path: string; line: number; text: string }[] = [];
    let searched = 0;
    for (const p of this.paths()) {
      const t = this.peek(p);
      if (t === null) continue;
      searched++;
      const lines = t.split("\n");
      for (let i = 0; i < lines.length && contentMatches.length < max; i++) if (re.test(lines[i])) contentMatches.push({ path: p, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
    return { pathMatches, contentMatches, searched };
  }

  /** Fetches small text files so search covers them (bounded). */
  async prefetch(paths: string[], maxFiles = 40, maxBytes = 300_000) {
    let bytes = 0;
    const todo = paths.filter((p) => this.base.has(p) && !this.cache.has(p)).filter((p) => { const s = this.base.get(p)!.size; if (bytes + s > maxBytes) return false; bytes += s; return true; }).slice(0, maxFiles);
    await Promise.all(todo.map((p) => this.baseText(p).catch(() => "")));
  }

  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [path, after] of [...this.staged].sort(([a], [b]) => a.localeCompare(b))) {
      const inBase = this.base.has(path);
      const before = inBase ? this.cache.get(path) : undefined;
      if (after === null) {
        if (!inBase) continue;
        const removed = before !== undefined ? fileDiff(before, "").length : this.base.get(path)!.size ? 1 : 0;
        out.push({ path, status: "deleted", before, added: 0, removed });
        continue;
      }
      if (inBase && before === after) continue;
      const st = diffStats(fileDiff(before ?? "", after));
      out.push({ path, status: inBase ? "modified" : "added", before, after, ...st });
    }
    return out;
  }

  /** path → new content or null (deleted), for the commit. */
  changeSet(): Record<string, string | null> {
    return Object.fromEntries(this.changes().map((c) => [c.path, c.status === "deleted" ? null : c.after!]));
  }

  diff(path?: string): string {
    return this.changes()
      .filter((c) => !path || c.path === path)
      .map((c) => unifiedDiff(c.path, c.status === "added" ? undefined : c.before ?? "", c.status === "deleted" ? undefined : c.after))
      .filter(Boolean)
      .join("\n");
  }
}

export function githubSource(gh: GitHubClient, repo: string): RepoSource {
  return { read: (_path, sha) => gh.getBlobText(repo, sha) };
}

/** Compact tree listing for prompts: directories collapsed when they hold many files. */
export function treeListing(paths: string[], maxChars = 6000): string {
  const lines: string[] = [];
  const byDir = new Map<string, string[]>();
  for (const p of paths) { const d = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "."; (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(p.split("/").pop()!); }
  for (const [d, names] of [...byDir].sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)))) {
    const shown = names.length > 25 ? [...names.slice(0, 20), `… +${names.length - 20} more`] : names;
    lines.push(`${d === "." ? "(root)" : d + "/"}: ${shown.join(", ")}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n… (${paths.length} files total)`;
  return out;
}

/** Picks the files the PM should see up front: README, manifests, configs, entry points. */
export function keyFiles(paths: string[], pkgJson?: string): string[] {
  const set = new Set(paths);
  const pick: string[] = [];
  const add = (p?: string) => { if (p && set.has(p) && !pick.includes(p)) pick.push(p); };
  for (const p of paths) if (/^readme(\.md|\.markdown|\.txt)?$/i.test(p)) add(p);
  for (const p of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json", "vite.config.ts", "vite.config.js", "index.html"]) add(p);
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as { main?: string; module?: string; bin?: string | Record<string, string>; exports?: unknown };
      add(pkg.main?.replace(/^\.\//, ""));
      add(pkg.module?.replace(/^\.\//, ""));
    } catch { /* ignore */ }
  }
  for (const p of ["src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "index.js", "main.py", "app.py", "src/lib.rs", "main.go"]) add(p);
  return pick.slice(0, 6);
}
