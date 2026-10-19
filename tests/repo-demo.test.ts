import { describe, expect, it } from "vitest";
import { Orchestrator, DEFAULT_CONFIG } from "../src/engine/orchestrator";
import { DemoLLM, DEMO_PRICING } from "../src/demo/demo-llm";
import { DEMO_GH_TOKEN, DEMO_REPO, DEMO_REPO_TASK, demoGitHub } from "../src/demo/demo-repo";
import { GitHubClient, PatAuth } from "../src/engine/github";
import { repoDeps } from "../src/engine/repo-run";
import type { GateRequest, RunEvent } from "../src/engine/types";

function setup(gates = { plan: true, review: true, deploy: true }) {
  const fake = demoGitHub();
  const gh = new GitHubClient(new PatAuth(DEMO_GH_TOKEN), { fetchImpl: fake.fetch });
  const o = new Orchestrator({
    llm: new DemoLLM({ speed: 0, script: "repo" }),
    runId: "test-repo-1",
    config: { ...DEFAULT_CONFIG, task: DEMO_REPO_TASK, mode: "repo", repo: { repo: DEMO_REPO, branch: "main" }, pricing: DEMO_PRICING, budgetUsd: 5, gates },
    ...repoDeps(gh, { repo: DEMO_REPO, branch: "main" }, { shortId: () => "a1b2c3" }),
    modelLabel: "demo",
  });
  const events: RunEvent[] = [];
  const gatesSeen: GateRequest[] = [];
  o.on((e) => {
    events.push(e);
    if (e.type === "gate") { gatesSeen.push(e.gate); queueMicrotask(() => o.decide(e.gate.id, { action: "approve" })); }
  });
  return { fake, o, events, gatesSeen };
}

describe("repo demo: fix a bug → PR", () => {
  it("reads the repo, patches, catches a syntax error, fixes it and opens one PR", async () => {
    const { fake, o, events, gatesSeen } = setup();
    const status = await o.run();
    expect(o.error).toBe("");
    expect(status).toBe("done");
    expect(gatesSeen.map((g) => g.kind)).toEqual(["plan", "review", "pr"]);
    const repoEv = events.find((e) => e.type === "repo") as Extract<RunEvent, { type: "repo" }>;
    expect(repoEv.files).toBe(7); // lockfile, node_modules and the png are ignored
    expect(repoEv.ignored).toBe(3);
    const checks = events.filter((e) => e.type === "checks") as Extract<RunEvent, { type: "checks" }>[];
    expect(checks[0].report.ok).toBe(false);
    expect(checks[0].report.results.find((r) => r.id === "js")!.details[0]).toMatch(/src\/cart\.mjs/);
    expect(checks[1].report.ok).toBe(true);
    expect(o.pr).toEqual({ url: `https://github.com/${DEMO_REPO}/pull/8`, number: 8, branch: "overtime/fix-cart-subtotal-ignoring-item-a1b2c3", commitSha: expect.any(String) });
    const r = fake.repos.get(DEMO_REPO)!;
    expect(r.pulls).toHaveLength(1);
    expect(r.pulls[0].base).toBe("main");
    expect(r.pulls[0].body).toContain("Made with Overtime");
    expect(r.pulls[0].body).toContain("`src/cart.mjs` (modified, +1 −1)");
    const after = fake.filesAt(DEMO_REPO, o.pr!.branch);
    expect(after["src/cart.mjs"]).toContain("return item.price * (item.qty ?? 1);");
    expect(after["test/cart.test.mjs"]).toContain("issue #7");
    expect(after["package-lock.json"]).toBeDefined(); // untouched files carried over by base_tree
    // main never moved; nothing but GET/POST was ever sent
    expect(fake.filesAt(DEMO_REPO, "main")["src/cart.mjs"]).toContain("return item.price;\n");
    expect(fake.calls.every((c) => c.method === "GET" || c.method === "POST")).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits"))).toHaveLength(1);
  });
});
