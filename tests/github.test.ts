import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, PatAuth, assertSafeBranch, b64decode, b64encode } from "../src/engine/github";
import { FakeGitHub } from "../src/demo/fake-github";
import { loadSnapshot, RepoFS, githubSource, ignoreReason } from "../src/engine/repo";
import { redact } from "../src/engine/llm";
import { ghBodyAllowed, ghRouteAllowed } from "../worker/src/lib";

const TOKEN = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";

function setup(files: Record<string, string> = { "README.md": "# hi\n", "src/a.js": "export const a = 1;\n" }) {
  const fake = new FakeGitHub(TOKEN, "octo-dev", [{ full_name: "octo/app", files, protectedBranches: ["main"] }]);
  const gh = new GitHubClient(new PatAuth(TOKEN), { fetchImpl: fake.fetch });
  return { fake, gh };
}

describe("github client: reading", () => {
  it("sends the token in the proxy header only, never in the URL", async () => {
    const { fake, gh } = setup();
    expect((await gh.viewer()).login).toBe("octo-dev");
    const repos = await gh.listRepos();
    expect(repos.map((r) => r.full_name)).toEqual(["octo/app"]);
    expect(fake.calls.every((c) => c.token === TOKEN && !c.path.includes(TOKEN))).toBe(true);
    expect(gh.rate?.remaining).toBe(4999);
  });

  it("direct route uses an Authorization bearer header against api.github.com", async () => {
    const seen: { url: string; auth: string | null; proxy: string | null }[] = [];
    const { fake } = setup();
    const gh = new GitHubClient(new PatAuth(TOKEN), { route: "direct", fetchImpl: async (u, init) => { const h = new Headers(init?.headers); seen.push({ url: String(u), auth: h.get("authorization"), proxy: h.get("x-ot-gh-token") }); return fake.fetch(u, init); } });
    await gh.viewer();
    expect(seen[0]).toEqual({ url: "https://api.github.com/user", auth: `Bearer ${TOKEN}`, proxy: null });
  });

  it("fetches the tree recursively, ignores node_modules/dist/lockfiles/binaries, reads blobs lazily and caches them", async () => {
    const big = "x".repeat(500_000);
    const { fake, gh } = setup({
      "README.md": "# app\n", "package.json": '{"name":"app"}', "src/index.ts": "export {}\n",
      "node_modules/x/index.js": "1", "dist/app.js": "1", "package-lock.json": "{}", "yarn.lock": "", "logo.png": "png", "huge.json": big,
    });
    const snap = await loadSnapshot(gh, "octo/app", "main");
    expect(snap.files.map((f) => f.path)).toEqual(["README.md", "package.json", "src/index.ts"]);
    expect(snap.ignored.count).toBe(6);
    expect(snap.ignored.reasons).toMatchObject({ "build/vendor directory": 2, lockfile: 2, binary: 1, "too large": 1 });
    const fs = new RepoFS(snap, githubSource(gh, "octo/app"));
    const before = fake.calls.filter((c) => c.path.includes("/git/blobs/")).length;
    expect(before).toBe(0); // nothing fetched until asked
    expect(await fs.read("src/index.ts")).toBe("export {}\n");
    await fs.read("src/index.ts");
    expect(fake.calls.filter((c) => c.path.includes("/git/blobs/")).length).toBe(1);
    expect(ignoreReason("a/b/coverage/x.js")).toBe("build/vendor directory");
  });

  it("round-trips UTF-8 through base64", () => {
    const s = "Kopi ☕ — Rp 15.000 · ñ";
    expect(b64decode(b64encode(s))).toBe(s);
  });
});

describe("github client: opening a PR", () => {
  it("blobs → tree → ONE commit → new overtime/ branch → PR; base untouched; deletions work", async () => {
    const { fake, gh } = setup();
    const pr = await gh.openPullRequest({ repo: "octo/app", base: "main", changes: { "src/a.js": "export const a = 2;\n", "src/b.js": "export const b = 1;\n", "README.md": null }, title: "Bump a", body: "Made with Overtime", slug: "Bump a!", shortId: () => "zz9" });
    expect(pr.branch).toBe("overtime/bump-a-zz9");
    expect(pr.url).toBe("https://github.com/octo/app/pull/8");
    const files = fake.filesAt("octo/app", pr.branch);
    expect(files).toEqual({ "src/a.js": "export const a = 2;\n", "src/b.js": "export const b = 1;\n" });
    expect(fake.filesAt("octo/app", "main")["README.md"]).toBe("# hi\n");
    const writes = fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace("/repos/octo/app", "")}`);
    expect(writes).toEqual(["POST /git/blobs", "POST /git/blobs", "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
    const pull = fake.repos.get("octo/app")!.pulls[0];
    expect(pull).toMatchObject({ head: "overtime/bump-a-zz9", base: "main", title: "Bump a" });
  });

  it("branch already exists (422) → retries with a new suffix", async () => {
    const { fake, gh } = setup();
    fake.repos.get("octo/app")!.refs.set("overtime/fix-aaa", fake.repos.get("octo/app")!.refs.get("main")!);
    const ids = ["aaa", "bbb"];
    const pr = await gh.openPullRequest({ repo: "octo/app", base: "main", changes: { "x.md": "x" }, title: "t", body: "b", slug: "fix", shortId: () => ids.shift()! });
    expect(pr.branch).toBe("overtime/fix-bbb");
    expect(fake.calls.filter((c) => c.path.endsWith("/git/refs"))).toHaveLength(2);
  });

  it("refuses unsafe branch names and empty change sets", async () => {
    expect(() => assertSafeBranch("main", "main")).toThrow();
    expect(() => assertSafeBranch("overtime/../main", "main")).toThrow();
    expect(() => assertSafeBranch("feature/x", "main")).toThrow();
    expect(() => assertSafeBranch("overtime/ok-1", "main")).not.toThrow();
    const { gh } = setup();
    await expect(gh.openPullRequest({ repo: "octo/app", base: "main", changes: {}, title: "t", body: "", slug: "s" })).rejects.toThrow(/no changes/);
  });

  const errCase = async (status: number, message: string, headers: Record<string, string> = {}, match = /^GET \/user$/) => {
    const { fake, gh } = setup();
    fake.failures.push({ match, status, message, headers });
    try {
      await gh.viewer();
      throw new Error("expected failure");
    } catch (e) {
      return e as GitHubError;
    }
  };

  it("maps 401, 403 scopes, 404, 409 and rate limits to clear errors", async () => {
    const e401 = await errCase(401, "Bad credentials");
    expect(e401.kind).toBe("auth");
    expect(e401.message).toMatch(/rejected the token/);
    const e403 = await errCase(403, "Resource not accessible by personal access token");
    expect(e403.kind).toBe("scope");
    expect(e403.message).toMatch(/Contents: read & write and Pull requests: read & write/);
    const e404 = await errCase(404, "Not Found");
    expect(e404.kind).toBe("not_found");
    const e409 = await errCase(409, "Git Repository is empty.");
    expect(e409.kind).toBe("conflict");
    const reset = Math.floor(Date.UTC(2026, 9, 19, 10, 30) / 1000);
    const rl = await errCase(403, "API rate limit exceeded for user", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    expect(rl.kind).toBe("rate_limit");
    expect(rl.resetAt).toBe(reset * 1000);
    expect(rl.message).toMatch(/resets at/);
    const sec = await errCase(429, "secondary rate limit", { "retry-after": "60" });
    expect(sec.kind).toBe("rate_limit");
    expect(sec.resetAt! - Date.now()).toBeGreaterThan(55_000);
  });

  it("surfaces protected-branch / ruleset rejections", async () => {
    const { fake, gh } = setup();
    fake.failures.push({ match: /^POST .*\/git\/refs$/, status: 422, message: "Repository rule violations found: Cannot create ref due to creations being restricted." });
    const err = await gh.openPullRequest({ repo: "octo/app", base: "main", changes: { "a.md": "a" }, title: "t", body: "", slug: "s" }).catch((e: unknown) => e) as GitHubError;
    expect(err.kind).toBe("protected");
    expect(err.message).toMatch(/Branch protection or a repository rule/);
  });

  it("422 from the PR endpoint is a validation error, not a retry loop", async () => {
    const { fake, gh } = setup();
    fake.failures.push({ match: /^POST .*\/pulls$/, status: 422, message: "Validation Failed: No commits between main and overtime/x" });
    const err = await gh.openPullRequest({ repo: "octo/app", base: "main", changes: { "a.md": "a" }, title: "t", body: "", slug: "s" }).catch((e: unknown) => e) as GitHubError;
    expect(err.kind).toBe("validation");
    expect(fake.calls.filter((c) => c.path.endsWith("/pulls"))).toHaveLength(1);
  });

  it("never echoes the token in errors", async () => {
    const { fake, gh } = setup();
    fake.failures.push({ match: /^GET \/user$/, status: 500, message: `token ${TOKEN} invalid; header Authorization: Bearer ${TOKEN}` });
    const err = (await gh.viewer().catch((e) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
  });

  it("an empty token fails before any request", async () => {
    const fake = new FakeGitHub(TOKEN);
    const gh = new GitHubClient(new PatAuth(""), { fetchImpl: fake.fetch });
    await expect(gh.viewer()).rejects.toMatchObject({ kind: "auth" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("token redaction", () => {
  it("redacts PATs, OpenRouter/OpenAI keys, bearer headers and key=value pairs", () => {
    const s = redact(`ghp_abcdefghijklmnopqrstuv github_pat_11AAAA_bbbbbbbbbbbbb sk-or-v1-0123456789abcdef sk-proj-abcdefghijk Bearer xyz.123 "x-ot-gh-token": "tok_secret_value" api_key=hunter2hunter2`);
    for (const leak of ["ghp_abc", "github_pat_11", "sk-or-v1-0123", "sk-proj", "xyz.123", "tok_secret_value", "hunter2"]) expect(s).not.toContain(leak);
  });
  it("redacts an explicit secret anywhere", () => {
    expect(redact("my key is CUSTOMSECRET9 ok", "CUSTOMSECRET9")).toBe("my key is [redacted] ok");
  });
});

describe("worker GitHub proxy allowlist", () => {
  it("forwards reads and create-only writes, nothing else", () => {
    expect(ghRouteAllowed("GET", "/user")).toBe(true);
    expect(ghRouteAllowed("GET", "/repos/o/r/git/trees/abc123")).toBe(true);
    expect(ghRouteAllowed("POST", "/repos/o/r/git/refs")).toBe(true);
    expect(ghRouteAllowed("POST", "/repos/o/r/pulls")).toBe(true);
    expect(ghRouteAllowed("PATCH", "/repos/o/r/git/refs/heads/main")).toBe(false);
    expect(ghRouteAllowed("DELETE", "/repos/o/r/git/refs/heads/x")).toBe(false);
    expect(ghRouteAllowed("PUT", "/repos/o/r/pulls/1/merge")).toBe(false);
    expect(ghRouteAllowed("PUT", "/repos/o/r/contents/a.md")).toBe(false);
    expect(ghRouteAllowed("GET", "/repos/o/r/../../user")).toBe(false);
    expect(ghRouteAllowed("POST", "/user/repos")).toBe(false);
  });
  it("only lets new overtime/* branches be created, never forced", () => {
    expect(ghBodyAllowed("/repos/o/r/git/refs", '{"ref":"refs/heads/overtime/fix-1","sha":"a"}')).toBeNull();
    expect(ghBodyAllowed("/repos/o/r/git/refs", '{"ref":"refs/heads/main","sha":"a"}')).toMatch(/overtime/);
    expect(ghBodyAllowed("/repos/o/r/git/refs", '{"ref":"refs/heads/overtime/x","sha":"a","force":true}')).toMatch(/force/);
    expect(ghBodyAllowed("/repos/o/r/git/refs", '{"ref":"refs/tags/v1","sha":"a"}')).toMatch(/overtime/);
  });
});
