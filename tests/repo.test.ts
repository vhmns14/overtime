import { describe, expect, it } from "vitest";
import { applyEdits, keyFiles, RepoFS, snapshotFromTree, summarizeFile, treeListing, type RepoSource } from "../src/engine/repo";
import { runRepoChecks, riskFlags, validatePackageJson } from "../src/engine/repo-checks";
import { unifiedDiff } from "../src/engine/diff";
import { parseToolCall } from "../src/engine/schema";
import { Orchestrator, DEFAULT_CONFIG, trimHistory } from "../src/engine/orchestrator";
import type { CompletionRequest, GateDecision, GateRequest, LLM, RunEvent } from "../src/engine/types";

function memFs(files: Record<string, string>) {
  const entries = Object.entries(files).map(([path, c], i) => ({ path, type: "blob" as const, sha: `sha${i}`, size: c.length, mode: "100644" }));
  const bySha = Object.fromEntries(entries.map((e) => [e.sha, files[e.path]]));
  const reads: string[] = [];
  const source: RepoSource = { read: async (p, sha) => { reads.push(p); return bySha[sha]; } };
  return { fs: new RepoFS(snapshotFromTree("o/r", "main", "base000", entries), source), reads };
}

describe("search/replace patches", () => {
  it("applies exact, unique edits in order", () => {
    const r = applyEdits("a\nb\nc\n", [{ search: "b\n", replace: "B\n" }, { search: "c", replace: "C" }]);
    expect(r).toEqual({ ok: true, content: "a\nB\nC\n", applied: 2 });
  });
  it("rejects missing, ambiguous and empty searches, and applies nothing on failure", () => {
    expect(applyEdits("x", [{ search: "y", replace: "z" }])).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(applyEdits("a a", [{ search: "a", replace: "b" }])).toMatchObject({ ok: false, error: expect.stringMatching(/matches 2 times/) });
    expect(applyEdits("a a", [{ search: "a", replace: "b", all: true }])).toMatchObject({ ok: true, content: "b b" });
    expect(applyEdits("a", [{ search: "", replace: "b" }])).toMatchObject({ ok: false });
    expect(applyEdits("    foo()", [{ search: "  foo()\n", replace: "" }])).toMatchObject({ ok: false });
    expect(applyEdits("  foo()", [{ search: "foo() ", replace: "" }]).ok).toBe(false);
    expect(applyEdits("ab", [{ search: "a", replace: "1" }, { search: "zz", replace: "2" }])).toMatchObject({ ok: false, error: expect.stringMatching(/edit 2/) });
  });
  it("hints when only whitespace differs", () => {
    const r = applyEdits("if (x) {\n    go();\n}", [{ search: "  go();  ", replace: "stop();" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/trim whitespace/);
  });
  it("$ patterns in the replacement are literal", () => {
    expect(applyEdits("price", [{ search: "price", replace: "$& $1 $$" }])).toMatchObject({ content: "$& $1 $$" });
  });
});

describe("virtual working tree", () => {
  it("stages writes, edits and deletes; lists changes and a git-style unified diff vs base", async () => {
    const { fs, reads } = memFs({ "a.js": "one\ntwo\nthree\n", "b.md": "# b\n", "c.txt": "c\n" });
    expect(reads).toEqual([]);
    const r = await fs.edit("a.js", [{ search: "two", replace: "TWO" }]);
    expect(r.ok).toBe(true);
    fs.write("new/d.ts", "export const d = 1;\n");
    await fs.read("c.txt");
    fs.delete("c.txt");
    expect(fs.paths()).toEqual(["a.js", "b.md", "new/d.ts"]);
    const ch = fs.changes();
    expect(ch.map((c) => `${c.status} ${c.path} +${c.added} -${c.removed}`)).toEqual(["modified a.js +1 -1", "deleted c.txt +0 -1", "added new/d.ts +1 -0"]);
    const d = fs.diff("a.js");
    expect(d).toBe(["diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n"));
    expect(fs.diff("new/d.ts")).toContain("--- /dev/null");
    expect(fs.diff("c.txt")).toContain("+++ /dev/null");
    expect(fs.changeSet()).toEqual({ "a.js": "one\nTWO\nthree\n", "c.txt": null, "new/d.ts": "export const d = 1;\n" });
  });
  it("writing back the original content is not a change", async () => {
    const { fs } = memFs({ "a.js": "x\n" });
    await fs.read("a.js");
    fs.write("a.js", "x\n");
    expect(fs.changes()).toEqual([]);
  });
  it("searches paths everywhere and content in files read so far", async () => {
    const { fs } = memFs({ "src/cart.js": "function lineTotal() {}\n", "src/other.js": "lineTotal()\n" });
    await fs.read("src/cart.js");
    const r = fs.search("linetotal");
    expect(r.contentMatches).toEqual([{ path: "src/cart.js", line: 1, text: "function lineTotal() {}" }]);
    expect(fs.search("cart").pathMatches).toEqual(["src/cart.js"]);
    await fs.prefetch(["src/other.js"]);
    expect(fs.search("lineTotal").contentMatches).toHaveLength(2);
    expect(fs.search("(", { regex: true }).error).toBe("invalid regex");
  });
  it("unified diff hunks merge nearby changes and keep far ones apart", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
    const b = a.replace("l2\n", "L2\n").replace("l4\n", "L4\n").replace("l25", "L25");
    const d = unifiedDiff("f", a, b);
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(d).toContain("@@ -1,7 +1,7 @@");
    expect(d).toContain("@@ -22,7 +22,7 @@");
  });
  it("summarises big files and builds a compact tree + key files", () => {
    const big = Array.from({ length: 3000 }, (_, i) => (i % 100 === 0 ? `export function f${i}() {}` : `// line ${i}`)).join("\n");
    const s = summarizeFile("big.ts", big, 6000);
    expect(s.length).toBeLessThan(9000);
    expect(s).toContain("showing head, outline and tail");
    expect(s).toContain("export function f2900");
    expect(treeListing(["README.md", "src/a.ts", "src/b.ts"])).toBe("(root): README.md\nsrc/: a.ts, b.ts");
    expect(keyFiles(["README.md", "package.json", "lib/main.js", "src/index.ts"], '{"main":"./lib/main.js"}')).toEqual(["README.md", "package.json", "lib/main.js", "src/index.ts"]);
  });
});

describe("repo checks and risk flags", () => {
  const ch = (path: string, after: string | undefined, before = "", status: "added" | "modified" | "deleted" = "modified", removed = 1) => ({ path, status, before, after, added: 1, removed });
  it("JS syntax on changed files only, JSON and package.json validity", () => {
    const r = runRepoChecks([ch("a.mjs", "export const x = (1;\n"), ch("ok.js", "import a from './a.mjs';\nexport default a;\n"), ch("package.json", '{"name":"Bad Name","version":"1","dependencies":{"x":1}}'), ch("data.json", "{bad")], {});
    expect(r.ok).toBe(false);
    const js = r.results.find((x) => x.id === "js")!;
    expect(js.details).toHaveLength(1);
    expect(js.details[0]).toMatch(/^a\.mjs:/);
    const json = r.results.find((x) => x.id === "json")!.details.join("\n");
    expect(json).toMatch(/package\.json: "name"/);
    expect(json).toMatch(/package\.json: "version"/);
    expect(json).toMatch(/dependencies\.x/);
    expect(json).toMatch(/data\.json: invalid JSON/);
  });
  it("TS gets a balance check", () => {
    const r = runRepoChecks([ch("a.ts", "export function f(x: number): number { return (x;\n}")], {});
    expect(r.results.find((x) => x.id === "ts")!.status).toBe("fail");
  });
  it("validatePackageJson accepts a normal manifest", () => {
    expect(validatePackageJson('{"name":"@scope/pkg","version":"1.2.3","scripts":{"t":"x"}}')).toEqual([]);
  });
  it("flags workflows, secrets, lockfile mass edits, deletions and big removals; they are warnings, not failures", () => {
    const changes = [
      ch(".github/workflows/ci.yml", "x"),
      ch(".env.production", "KEY=1", "", "added"),
      { path: "package-lock.json", status: "modified" as const, before: "", after: "x", added: 400, removed: 300 },
      ch("old.js", undefined, "a\nb", "deleted"),
      { path: "big.js", status: "modified" as const, before: "", after: "x", added: 1, removed: 500 },
      ch("config.js", "const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123';"),
    ];
    const ids = riskFlags(changes).map((r) => r.id).sort();
    expect(ids).toEqual(["big-delete", "delete", "lockfile", "secret-text", "secrets", "workflow"]);
    const r = runRepoChecks(changes, {});
    expect(r.risks).toHaveLength(6);
    expect(r.results.find((x) => x.id === "risk")!.status).toBe("warn");
  });
  it("HTML/CSS checks judge only the changed files", () => {
    const files = { "index.html": '<!doctype html><html lang="en"><head><title>x</title></head><body><img src="a.png"></body></html>', "other.html": '<img src="nope.png">' };
    const r = runRepoChecks([ch("index.html", files["index.html"])], { ...files, "a.png": "" });
    expect(r.results.find((x) => x.id === "alt")!.details[0]).toMatch(/^index\.html/);
    expect(r.results.find((x) => x.id === "links")!.status).toBe("pass"); // other.html's broken link is not ours
  });
});

describe("schema: repo tools", () => {
  it("only repo mode exposes edit/search/delete, with typed args", () => {
    const edit = JSON.stringify({ thought: "t", tool: "edit_file", args: { path: "a.js", edits: [{ search: "a", replace: "b" }] } });
    expect(parseToolCall(edit, "coder", "site").ok).toBe(false);
    expect(parseToolCall(edit, "coder", "repo").ok).toBe(true);
    expect(parseToolCall(edit, "research", "repo").ok).toBe(false);
    const read = JSON.stringify({ thought: "", tool: "read_file", args: { path: "a.js", start_line: "1" } });
    expect(parseToolCall(read, "coder", "repo")).toMatchObject({ ok: false, error: expect.stringMatching(/start_line" must be number/) });
    expect(parseToolCall(JSON.stringify({ tool: "search_repo", args: { query: "x" } }), "pm", "repo").ok).toBe(true);
  });
});

// ---------- orchestrator in repo mode with scripted replies ----------
type Reply = (req: CompletionRequest) => string;
class ByRole implements LLM {
  label = "script";
  steps: Record<string, number> = {};
  constructor(private script: Partial<Record<string, Reply[]>>) {}
  async complete(req: CompletionRequest) {
    const i = (this.steps[req.agent] = (this.steps[req.agent] ?? -1) + 1);
    const list = this.script[req.agent] ?? [];
    const f = list[Math.min(i, list.length - 1)];
    if (!f) throw new Error(`no reply for ${req.agent}`);
    return { text: f(req), usage: { prompt: 100, completion: 20 } };
  }
}
const J = (tool: string, args: Record<string, unknown>, thought = "ok") => () => JSON.stringify({ thought, tool, args });
const plan = J("handoff", { to: "research", summary: "s", plan: "change a.js", files: ["a.js"], tickets: [{ id: "T1", title: "edit a.js", owner: "coder" }] });

function repoRun(script: Partial<Record<string, Reply[]>>, answer: (g: GateRequest) => GateDecision = () => ({ action: "approve" }), opts: { files?: Record<string, string>; openPR?: boolean; prError?: Error } = {}) {
  const { fs } = memFs(opts.files ?? { "a.js": "const a = 1;\n", "b.js": "const b = 2;\n" });
  const opened: { title: string; body: string; changes: Record<string, string | null> }[] = [];
  const o = new Orchestrator({
    llm: new ByRole(script), runId: "r1",
    config: { ...DEFAULT_CONFIG, task: "Change a", mode: "repo", repo: { repo: "o/r", branch: "main" }, budgetUsd: 5 },
    loadRepo: async () => fs,
    openPR: opts.openPR === false ? undefined : async (p) => { if (opts.prError) throw opts.prError; opened.push(p); return { url: "https://github.com/o/r/pull/1", number: 1, branch: "overtime/x-1" }; },
  });
  const gates: GateRequest[] = [];
  const events: RunEvent[] = [];
  o.on((e) => { events.push(e); if (e.type === "gate") { gates.push(e.gate); queueMicrotask(() => o.decide(e.gate.id, answer(e.gate))); } });
  return { o, fs, gates, opened, events };
}
const base = {
  pm: [plan],
  research: [J("handoff", { to: "coder", summary: "go", brief: "edit a.js" })],
  reviewer: [J("run_checks", {}), J("handoff", { to: "ops", verdict: "pass", summary: "ok" })],
  ops: [J("finish", { summary: "1 file", title: "Change a" })],
};

describe("orchestrator: repo mode", () => {
  it("a bad patch is reported back to the coder, who retries; the PR carries one change set", async () => {
    const { o, gates, opened } = repoRun({
      ...base,
      coder: [J("edit_file", { path: "a.js", edits: [{ search: "const a = 9;", replace: "x" }] }), J("read_file", { path: "a.js" }), J("edit_file", { path: "a.js", edits: [{ search: "const a = 1;", replace: "const a = 2;" }] }), J("handoff", { to: "reviewer", summary: "done" })],
    });
    expect(await o.run()).toBe("done");
    expect(o.log.some((l) => /did not apply: edit 1: search text not found/.test(l.text))).toBe(true);
    expect(gates.map((g) => g.kind)).toEqual(["plan", "pr"]);
    expect(opened[0].changes).toEqual({ "a.js": "const a = 2;\n" });
    expect(opened[0].body).toContain("## Files changed\n- `a.js` (modified, +1 −1)");
    expect(opened[0].body).toContain("Made with Overtime");
    expect(opened[0].body).toMatch(/## Cost\n[\d,]+ tokens · \$/);
  });

  it("delete_file is gated: a refusal keeps the file", async () => {
    const { o, gates, fs } = repoRun(
      { ...base, coder: [J("delete_file", { path: "b.js", reason: "unused" }), J("edit_file", { path: "a.js", edits: [{ search: "1", replace: "2" }] }), J("handoff", { to: "reviewer", summary: "d" })] },
      (g) => ({ action: g.kind === "delete" ? "reject" : "approve" }),
    );
    expect(await o.run()).toBe("done");
    expect(gates.map((g) => g.kind)).toEqual(["plan", "delete", "pr"]);
    expect(fs.has("b.js")).toBe(true);
  });

  it("risky changes are listed on the PR gate, which is shown even when the deploy gate is off", async () => {
    const { o, gates } = repoRun({ ...base, coder: [J("write_file", { path: ".github/workflows/x.yml", content: "on: push\n" }), J("handoff", { to: "reviewer", summary: "d" })] });
    o.config.gates.deploy = false;
    o.config.gates.plan = false;
    expect(await o.run()).toBe("done");
    expect(gates.map((g) => g.kind)).toEqual(["pr"]);
    expect(gates[0].title).toMatch(/1 risky change/);
    expect(gates[0].items![0]).toMatch(/⚠ \.github\/workflows\/x\.yml: changes CI/);
  });

  it("rejecting the PR gate opens nothing", async () => {
    const { o, opened } = repoRun({ ...base, coder: [J("edit_file", { path: "a.js", edits: [{ search: "1", replace: "2" }] }), J("handoff", { to: "reviewer", summary: "d" })] }, (g) => ({ action: g.kind === "pr" ? "reject" : "approve" }));
    expect(await o.run()).toBe("done");
    expect(opened).toHaveLength(0);
    expect(o.steps.deploy.state).toBe("skipped");
    expect(o.summary).toMatch(/PR not opened/);
  });

  it("dry run (no openPR) stops before GitHub", async () => {
    const { o } = repoRun({ ...base, coder: [J("edit_file", { path: "a.js", edits: [{ search: "1", replace: "2" }] }), J("handoff", { to: "reviewer", summary: "d" })] }, undefined, { openPR: false });
    expect(await o.run()).toBe("done");
    expect(o.summary).toMatch(/dry run/);
  });

  it("a GitHub failure while opening the PR fails the run with the clear message", async () => {
    const { o } = repoRun({ ...base, coder: [J("edit_file", { path: "a.js", edits: [{ search: "1", replace: "2" }] }), J("handoff", { to: "reviewer", summary: "d" })] }, undefined, { prError: new Error("GitHub refused POST /repos/…/git/refs (403). The token needs Contents: read & write") });
    expect(await o.run()).toBe("failed");
    expect(o.error).toMatch(/Contents: read & write/);
  });

  it("no changes → no PR", async () => {
    const { o, opened } = repoRun({ ...base, coder: [J("handoff", { to: "reviewer", summary: "nothing" })], reviewer: [J("run_checks", {}), J("handoff", { to: "coder", verdict: "fix", summary: "x" })] });
    o.config.maxReviewRounds = 0;
    expect(await o.run()).toBe("done");
    expect(opened).toHaveLength(0);
    expect(o.summary).toBe("no changes");
  });

  it("refuses paths that escape the repo or touch .git", async () => {
    const { o, fs } = repoRun({ ...base, coder: [J("write_file", { path: "../x.js", content: "1" }), J("write_file", { path: ".git/config", content: "1" }), J("edit_file", { path: "a.js", edits: [{ search: "1", replace: "2" }] }), J("handoff", { to: "reviewer", summary: "d" })] });
    expect(await o.run()).toBe("done");
    expect(fs.paths()).toEqual(["a.js", "b.js"]);
  });
});

describe("context budget", () => {
  it("elides the oldest tool results first", () => {
    const m = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }, { role: "assistant" as const, content: "a" }, { role: "user" as const, content: "TOOL RESULT (read_file): " + "x".repeat(5000) }, { role: "assistant" as const, content: "a" }, { role: "user" as const, content: "TOOL RESULT (read_file): " + "y".repeat(5000) }, { role: "assistant" as const, content: "a" }, { role: "user" as const, content: "latest" }];
    trimHistory(m, 6000);
    expect(m[3].content).toMatch(/elided/);
    expect(m[5].content.length).toBeGreaterThan(5000);
  });
});
