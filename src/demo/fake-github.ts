// An in-memory GitHub REST API behind a fetch-compatible function. The PR demo runs on it (fully
// offline), and the unit tests use it as the mock for tree reads, blobs, commits, refs and PRs,
// with error injection for the failure paths. It refuses everything Overtime must never do
// (updating or deleting refs, merging) so a test fails loudly if the client ever tries.

import { b64decode, b64encode } from "../engine/github";

export interface FakeRepoSeed {
  full_name: string;
  default_branch?: string;
  private?: boolean;
  description?: string;
  files: Record<string, string>;
  protectedBranches?: string[];
  extraBranches?: string[];
}

interface Commit { sha: string; tree: string; parents: string[]; message: string }
interface Repo {
  info: { full_name: string; default_branch: string; private: boolean; description: string; permissions: { push: boolean; admin: boolean }; pushed_at: string };
  refs: Map<string, string>; // branch → commit sha
  protected: Set<string>;
  commits: Map<string, Commit>;
  trees: Map<string, Map<string, string>>; // tree sha → path → blob sha
  blobs: Map<string, string>;
  pulls: { number: number; title: string; head: string; base: string; body: string; html_url: string }[];
}

export interface FakeFailure {
  /** METHOD + path regex, e.g. /^POST .*\/git\/refs$/ */
  match: RegExp;
  status: number;
  message?: string;
  headers?: Record<string, string>;
  /** how many times to fail (default: always) */
  times?: number;
}

export interface FakeCall { method: string; path: string; token: string; body?: unknown }

function hash(s: string): string {
  // deterministic 40-hex id (FNV-1a over 5 seeds); not cryptographic, just stable
  let out = "";
  for (let seed = 0; seed < 5; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export class FakeGitHub {
  readonly repos = new Map<string, Repo>();
  readonly calls: FakeCall[] = [];
  failures: FakeFailure[] = [];
  latencyMs = 0;
  private prSeq = 7;

  constructor(readonly token: string, readonly login = "octo-dev", seeds: FakeRepoSeed[] = []) {
    for (const s of seeds) this.addRepo(s);
  }

  addRepo(seed: FakeRepoSeed) {
    const branch = seed.default_branch ?? "main";
    const r: Repo = {
      info: { full_name: seed.full_name, default_branch: branch, private: seed.private ?? false, description: seed.description ?? "", permissions: { push: true, admin: false }, pushed_at: "2026-10-18T09:00:00Z" },
      refs: new Map(), protected: new Set(seed.protectedBranches ?? []), commits: new Map(), trees: new Map(), blobs: new Map(), pulls: [],
    };
    const files = new Map<string, string>();
    for (const [p, c] of Object.entries(seed.files)) { const sha = hash("blob:" + c); r.blobs.set(sha, c); files.set(p, sha); }
    const tree = this.putTree(r, files);
    const c: Commit = { sha: hash(`commit:${tree}:init`), tree, parents: [], message: "Initial commit" };
    r.commits.set(c.sha, c);
    r.refs.set(branch, c.sha);
    for (const b of seed.extraBranches ?? []) r.refs.set(b, c.sha);
    this.repos.set(seed.full_name, r);
    return r;
  }

  private putTree(r: Repo, files: Map<string, string>) {
    const sha = hash("tree:" + [...files].sort().map(([p, s]) => p + "=" + s).join("\n"));
    r.trees.set(sha, new Map(files));
    return sha;
  }

  /** current content of a branch, for assertions */
  filesAt(repo: string, branch: string): Record<string, string> {
    const r = this.repos.get(repo)!;
    const c = r.commits.get(r.refs.get(branch)!)!;
    return Object.fromEntries([...r.trees.get(c.tree)!].map(([p, s]) => [p, r.blobs.get(s)!]));
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://local");
    const path = url.pathname.replace(/^\/api\/gh/, "") + url.search;
    const method = (init.method ?? "GET").toUpperCase();
    const h = new Headers(init.headers);
    const token = h.get("x-ot-gh-token") ?? (h.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    let body: unknown;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    this.calls.push({ method, path, token, body });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const key = `${method} ${path.split("?")[0]}`;
    for (const f of this.failures) {
      if (!f.match.test(key) || f.times === 0) continue;
      if (f.times) f.times--;
      return json({ message: f.message ?? "error" }, f.status, f.headers);
    }
    if (token !== this.token) return json({ message: "Bad credentials" }, 401);
    try {
      return this.route(method, path, body);
    } catch (e) {
      return json({ message: (e as Error).message }, 500);
    }
  };

  private route(method: string, full: string, body: unknown): Response {
    const [path, q = ""] = full.split("?");
    const rate = { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 9, 19, 9) / 1000)) };
    if (method === "GET" && path === "/user") return json({ login: this.login, name: "Octo Dev" }, 200, rate);
    if (method === "GET" && path === "/user/repos") {
      const page = Number(new URLSearchParams(q).get("page") ?? 1);
      return json(page === 1 ? [...this.repos.values()].map((r) => r.info) : [], 200, rate);
    }
    const m = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)(\/.*)?$/);
    if (!m) return json({ message: "Not Found" }, 404);
    const r = this.repos.get(m[1]);
    if (!r) return json({ message: "Not Found" }, 404);
    const rest = m[2] ?? "";
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && rest === "") return json(r.info, 200, rate);
    if (method === "GET" && rest === "/branches") return json([...r.refs].map(([name, sha]) => ({ name, commit: { sha }, protected: r.protected.has(name) })), 200, rate);
    let x = rest.match(/^\/branches\/(.+)$/);
    if (method === "GET" && x) {
      const name = decodeURIComponent(x[1]);
      const sha = r.refs.get(name);
      return sha ? json({ name, commit: { sha }, protected: r.protected.has(name) }) : json({ message: "Branch not found" }, 404);
    }
    x = rest.match(/^\/git\/commits\/(\w+)$/);
    if (method === "GET" && x) {
      const c = r.commits.get(x[1]);
      return c ? json({ sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json({ message: "Not Found" }, 404);
    }
    x = rest.match(/^\/git\/trees\/(\w+)$/);
    if (method === "GET" && x) {
      const t = r.trees.get(x[1]);
      if (!t) return json({ message: "Not Found" }, 404);
      const dirs = new Set<string>();
      for (const p of t.keys()) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
      const tree = [
        ...[...dirs].map((p) => ({ path: p, mode: "040000", type: "tree", sha: hash("dir:" + p) })),
        ...[...t].map(([p, sha]) => ({ path: p, mode: "100644", type: "blob", sha, size: new TextEncoder().encode(r.blobs.get(sha) ?? "").length })),
      ].sort((a, z) => a.path.localeCompare(z.path));
      return json({ sha: x[1], tree, truncated: false });
    }
    x = rest.match(/^\/git\/blobs\/(\w+)$/);
    if (method === "GET" && x) {
      const c = r.blobs.get(x[1]);
      return c === undefined ? json({ message: "Not Found" }, 404) : json({ sha: x[1], content: b64encode(c), encoding: "base64", size: c.length });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const content = b.encoding === "base64" ? b64decode(String(b.content)) : String(b.content);
      const sha = hash("blob:" + content);
      r.blobs.set(sha, content);
      return json({ sha }, 201);
    }
    if (method === "POST" && rest === "/git/trees") {
      const base = r.trees.get(String(b.base_tree));
      if (!base) return json({ message: "base_tree not found" }, 422);
      const files = new Map(base);
      for (const e of (b.tree as { path: string; sha: string | null }[]) ?? []) {
        if (e.sha === null) { if (!files.delete(e.path)) return json({ message: `tree.path ${e.path} does not exist` }, 422); }
        else if (!r.blobs.has(e.sha)) return json({ message: "tree.sha is not a valid blob" }, 422);
        else files.set(e.path, e.sha);
      }
      return json({ sha: this.putTree(r, files) }, 201);
    }
    if (method === "POST" && rest === "/git/commits") {
      const tree = String(b.tree);
      if (!r.trees.has(tree)) return json({ message: "tree not found" }, 422);
      const parents = (b.parents as string[]) ?? [];
      const c: Commit = { sha: hash(`commit:${tree}:${parents.join(",")}:${b.message}`), tree, parents, message: String(b.message) };
      r.commits.set(c.sha, c);
      return json({ sha: c.sha, tree: { sha: tree } }, 201);
    }
    if (method === "POST" && rest === "/git/refs") {
      const ref = String(b.ref);
      const name = ref.replace(/^refs\/heads\//, "");
      if (!ref.startsWith("refs/heads/")) return json({ message: "Reference name must start with refs/heads/" }, 422);
      if (r.refs.has(name)) return json({ message: "Reference already exists" }, 422);
      if (!r.commits.has(String(b.sha))) return json({ message: "Object does not exist" }, 422);
      r.refs.set(name, String(b.sha));
      return json({ ref, object: { sha: b.sha } }, 201);
    }
    if (method === "POST" && rest === "/pulls") {
      const head = String(b.head), base = String(b.base);
      if (!r.refs.has(head) || !r.refs.has(base)) return json({ message: "Validation Failed: head or base not found" }, 422);
      if (r.pulls.some((p) => p.head === head)) return json({ message: "A pull request already exists" }, 422);
      const number = ++this.prSeq;
      const pr = { number, title: String(b.title), head, base, body: String(b.body ?? ""), html_url: `https://github.com/${r.info.full_name}/pull/${number}` };
      r.pulls.push(pr);
      return json(pr, 201);
    }
    // PATCH/PUT/DELETE (ref updates, force pushes, merges) are never valid for Overtime
    return json({ message: `Fake GitHub refuses ${method} ${rest}` }, method === "GET" ? 404 : 405);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
