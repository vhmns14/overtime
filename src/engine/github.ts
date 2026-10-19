// GitHub REST client for repo mode: read a repo (tree, blobs), then open ONE pull request built with
// the git data API (blobs → tree → commit → new branch ref → PR). It never updates an existing ref,
// never force-pushes and never merges: there is no code path for any of that.
//
// Auth is pluggable. A personal access token (PAT) is implemented today; an OAuth App or GitHub App
// flow only needs another AuthProvider that resolves to a bearer token.

import { redact } from "./llm";

export interface AuthProvider {
  readonly kind: "pat" | "oauth" | "app";
  readonly label: string;
  /** a bearer token for api.github.com (installation token, user-to-server token or PAT) */
  token(): Promise<string>;
}

export class PatAuth implements AuthProvider {
  readonly kind = "pat" as const;
  readonly label = "Fine-grained personal access token";
  constructor(private pat: string) {}
  async token() { return this.pat.trim(); }
}

export type GitHubErrorKind = "auth" | "scope" | "not_found" | "conflict" | "validation" | "rate_limit" | "protected" | "network" | "server";

export class GitHubError extends Error {
  constructor(message: string, readonly kind: GitHubErrorKind, readonly status = 0, readonly resetAt?: number) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubOptions {
  /** "proxy": through the Worker's /api/gh (token in a header, never stored); "direct": api.github.com */
  route?: "proxy" | "direct";
  proxyUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export interface RepoInfo { full_name: string; default_branch: string; private: boolean; permissions?: { push?: boolean; admin?: boolean }; description?: string | null; pushed_at?: string }
export interface BranchInfo { name: string; sha: string; protected: boolean }
export interface TreeEntry { path: string; type: "blob" | "tree" | "commit"; sha: string; size?: number; mode: string }

export const BRANCH_PREFIX = "overtime/";

const enc = encodeURIComponent;
const repoPath = (full: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) throw new GitHubError("Repository must look like owner/name", "validation");
  return `/repos/${full}`;
};

/** base64 → UTF-8 text (browser and Node). */
export function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubClient {
  private route: "proxy" | "direct";
  private fetchImpl: typeof fetch;
  /** last seen rate-limit window (for the UI) */
  rate: { remaining: number; resetAt: number } | null = null;

  constructor(readonly auth: AuthProvider, private o: GitHubOptions = {}) {
    this.route = o.route ?? "proxy";
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await this.auth.token();
    if (!token) throw new GitHubError("Connect GitHub first: no token", "auth", 401);
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let url: string;
    if (this.route === "direct") {
      url = (this.o.apiBase ?? "https://api.github.com") + path;
      headers.authorization = `Bearer ${token}`;
    } else {
      url = (this.o.proxyUrl ?? "/api/gh") + path;
      headers["x-ot-gh-token"] = token; // forwarded by the Worker, never stored or logged
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new GitHubError(`Network error reaching ${this.route === "direct" ? "api.github.com" : "the GitHub proxy"}`, "network");
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining !== null && reset !== null) this.rate = { remaining: Number(remaining), resetAt: Number(reset) * 1000 };
    const text = await res.text();
    if (!res.ok) throw this.toError(res, text, method, path, token);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitHubError("GitHub returned a non-JSON response", "server", res.status);
    }
  }

  private toError(res: Response, text: string, method: string, path: string, token: string): GitHubError {
    let msg = "";
    try { msg = String((JSON.parse(text) as { message?: string }).message ?? ""); } catch { msg = text.slice(0, 200); }
    msg = redact(msg, token);
    const where = `${method} ${path.split("?")[0].replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/…")}`;
    const s = res.status;
    const retryAfter = Number(res.headers.get("retry-after"));
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (s === 429 || (s === 403 && (remaining === "0" || /rate limit/i.test(msg)))) {
      const resetAt = retryAfter > 0 ? Date.now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : undefined;
      const when = resetAt ? new Date(resetAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "later";
      return new GitHubError(`GitHub rate limit hit. It resets at ${when}.`, "rate_limit", s, resetAt);
    }
    if (s === 401) return new GitHubError("GitHub rejected the token (401). It may be expired or mistyped.", "auth", s);
    if (/protected branch|repository rule|rule violations|cannot (?:create|update) ref/i.test(msg)) return new GitHubError(`Branch protection or a repository rule blocked this (${msg}).`, "protected", s);
    if (s === 403) return new GitHubError(`GitHub refused ${where} (403). The token needs Contents: read & write and Pull requests: read & write on this repo.${msg ? ` (${msg})` : ""}`, "scope", s);
    if (s === 404) return new GitHubError(`Not found: ${where}. The repo or branch does not exist, or the token cannot see it.`, "not_found", s);
    if (s === 409) return new GitHubError(`Conflict on ${where}${msg ? `: ${msg}` : ""}. The repository may be empty.`, "conflict", s);
    if (s === 422) return new GitHubError(`GitHub could not process ${where}: ${msg || "validation failed"}`, /already exists/i.test(msg) ? "conflict" : "validation", s);
    return new GitHubError(`GitHub ${s} on ${where}${msg ? `: ${msg}` : ""}`, "server", s);
  }

  // ---------- reading ----------
  viewer() { return this.request<{ login: string; name?: string | null }>("GET", "/user"); }

  async listRepos(maxPages = 3): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<RepoInfo[]>("GET", `/user/repos?per_page=100&sort=pushed&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  getRepo(full: string) { return this.request<RepoInfo>("GET", repoPath(full)); }

  async listBranches(full: string): Promise<BranchInfo[]> {
    const list = await this.request<{ name: string; commit: { sha: string }; protected?: boolean }[]>("GET", `${repoPath(full)}/branches?per_page=100`);
    return list.map((b) => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }));
  }

  async getBranch(full: string, branch: string): Promise<BranchInfo> {
    const b = await this.request<{ name: string; commit: { sha: string; commit?: { tree?: { sha: string } } }; protected?: boolean }>("GET", `${repoPath(full)}/branches/${enc(branch)}`);
    return { name: b.name, sha: b.commit.sha, protected: !!b.protected };
  }

  getCommit(full: string, sha: string) { return this.request<{ sha: string; tree: { sha: string } }>("GET", `${repoPath(full)}/git/commits/${sha}`); }

  getTree(full: string, sha: string) {
    return this.request<{ sha: string; tree: TreeEntry[]; truncated: boolean }>("GET", `${repoPath(full)}/git/trees/${sha}?recursive=1`);
  }

  async getBlobText(full: string, sha: string): Promise<string> {
    const b = await this.request<{ content: string; encoding: string; size: number }>("GET", `${repoPath(full)}/git/blobs/${sha}`);
    return b.encoding === "base64" ? b64decode(b.content) : b.content;
  }

  // ---------- writing (one PR, new branch only) ----------
  /**
   * Opens a pull request with every change in ONE commit on a fresh `overtime/<slug>-<id>` branch.
   * `changes` maps path → new content, or null to delete the file.
   */
  async openPullRequest(p: {
    repo: string;
    base: string;
    baseSha?: string;
    changes: Record<string, string | null>;
    title: string;
    body: string;
    slug: string;
    message?: string;
    shortId?: () => string;
    onStep?: (s: string) => void;
  }): Promise<{ url: string; number: number; branch: string; commitSha: string }> {
    const rp = repoPath(p.repo);
    const paths = Object.keys(p.changes);
    if (!paths.length) throw new GitHubError("Nothing to commit: no changes", "validation");
    const step = p.onStep ?? (() => {});
    const baseSha = p.baseSha ?? (await this.getBranch(p.repo, p.base)).sha;
    const baseCommit = await this.getCommit(p.repo, baseSha);
    step(`creating ${paths.filter((x) => p.changes[x] !== null).length} blob(s)`);
    const tree: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
    for (const path of paths) {
      const content = p.changes[path];
      if (content === null) { tree.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
      const blob = await this.request<{ sha: string }>("POST", `${rp}/git/blobs`, { content: b64encode(content), encoding: "base64" });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    step("writing tree");
    const newTree = await this.request<{ sha: string }>("POST", `${rp}/git/trees`, { base_tree: baseCommit.tree.sha, tree });
    step("committing");
    const commit = await this.request<{ sha: string }>("POST", `${rp}/git/commits`, { message: p.message ?? p.title, tree: newTree.sha, parents: [baseSha] });
    const slug = slugify(p.slug) || "change";
    const shortId = p.shortId ?? (() => Math.random().toString(36).slice(2, 8).padEnd(6, "0"));
    let branch = "";
    for (let attempt = 0; ; attempt++) {
      branch = `${BRANCH_PREFIX}${slug}-${shortId()}`;
      assertSafeBranch(branch, p.base);
      try {
        step(`creating branch ${branch}`);
        // POST /git/refs only creates; it fails if the ref exists. Nothing here can move or force a ref.
        await this.request("POST", `${rp}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        break;
      } catch (e) {
        if (e instanceof GitHubError && e.kind === "conflict" && attempt < 3) continue; // branch exists → new suffix
        throw e;
      }
    }
    step("opening pull request");
    const pr = await this.request<{ html_url: string; number: number }>("POST", `${rp}/pulls`, { title: p.title.slice(0, 250), head: branch, base: p.base, body: p.body, maintainer_can_modify: true });
    return { url: pr.html_url, number: pr.number, branch, commitSha: commit.sha };
  }
}

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
}

export function assertSafeBranch(branch: string, base: string) {
  if (!branch.startsWith(BRANCH_PREFIX) || branch === base || /\.\.|[~^:?*[\\\s]|@\{|\.lock$|\/$/.test(branch)) {
    throw new GitHubError(`Refusing to write to branch "${branch}"`, "validation");
  }
}
