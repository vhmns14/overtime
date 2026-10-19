import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSmoke, lookupPricing } from "../scripts/live-smoke-lib";
import { mockOpenAI } from "../src/demo/mock-openai";
import { DEMO_REPO, DEMO_REPO_TASK, demoGitHub } from "../src/demo/demo-repo";
import { FakeGitHub } from "../src/demo/fake-github";

const KEY = "sk-or-v1-smoketestsmoketestsmoketest00";
const env = (extra: Record<string, string> = {}) => ({ OVERTIME_LLM_BASE_URL: "https://openrouter.ai/api/v1", OVERTIME_LLM_KEY: KEY, OVERTIME_LLM_MODEL: "test/model", OVERTIME_PRICE_IN: "0.15", OVERTIME_PRICE_OUT: "0.6", ...extra });

describe("npm run live:smoke (against mocks)", () => {
  it("site mode: runs to done, writes the site, never prints the key", async () => {
    const mock = mockOpenAI();
    const lines: string[] = [];
    const out = mkdtempSync(join(tmpdir(), "smoke-"));
    const r = await runSmoke(env({ OVERTIME_TASK: "Build a landing page for Kopi Senja" }), { llmFetch: mock.fetch, outDir: out, log: (l) => lines.push(l) });
    expect(r.status).toBe("done");
    expect(r.mode).toBe("site");
    expect(r.output).toBe("tools");
    expect(r.gates).toEqual(["plan:approve", "review:approve", "deploy:approve"]);
    expect(r.usd).toBeGreaterThan(0);
    expect(readFileSync(join(r.outDir!, "index.html"), "utf8")).toContain("Kopi Senja");
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("repo mode is a dry run unless OVERTIME_GH_OPEN_PR=1", async () => {
    const gh = demoGitHub();
    const token = "github_pat_smoke_0123456789abcdefghij";
    const fake = new FakeGitHub(token, "octo", [...gh.repos.values()].map((r) => ({ full_name: r.info.full_name, files: gh.filesAt(r.info.full_name, r.info.default_branch) })));
    const lines: string[] = [];
    const dry = await runSmoke(env({ OVERTIME_TASK: DEMO_REPO_TASK, OVERTIME_GH_TOKEN: token, OVERTIME_GH_REPO: DEMO_REPO }), { llmFetch: mockOpenAI().fetch, ghFetch: fake.fetch, log: (l) => lines.push(l) });
    expect(dry.status).toBe("done");
    expect(dry.dryRun).toBe(true);
    expect(dry.pr).toBeNull();
    expect(dry.summary).toMatch(/dry run/);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(lines.join("\n")).toContain("+  return item.price * (item.qty ?? 1);");
    expect(lines.join("\n")).not.toContain(token);
    const wet = await runSmoke(env({ OVERTIME_TASK: DEMO_REPO_TASK, OVERTIME_GH_TOKEN: token, OVERTIME_GH_REPO: `${DEMO_REPO}@main`, OVERTIME_GH_OPEN_PR: "1" }), { llmFetch: mockOpenAI({ sloppy: true, noTools: true }).fetch, ghFetch: fake.fetch, log: () => {} });
    expect(wet.status).toBe("done");
    expect(wet.pr?.url).toMatch(/\/pull\/8$/);
    expect(wet.gates).toContain("pr:approve");
  });

  it("stops at the budget cap and reports it", async () => {
    const r = await runSmoke(env({ OVERTIME_BUDGET_USD: "0.001" }), { llmFetch: mockOpenAI().fetch, log: () => {}, outDir: mkdtempSync(join(tmpdir(), "smoke-")) });
    expect(r.status).toBe("budget");
    expect(r.usd).toBeLessThan(0.01);
  });

  it("looks up OpenRouter pricing so the cap is real", async () => {
    const f = (async () => new Response(JSON.stringify({ data: [{ id: "a/b", pricing: { prompt: "0.00000015", completion: "0.0000006" } }] }))) as unknown as typeof fetch;
    const p = await lookupPricing("https://openrouter.ai/api/v1", "a/b", f);
    expect(p!.input).toBeCloseTo(0.15);
    expect(p!.output).toBeCloseTo(0.6);
  });

  it("fails fast without config", async () => {
    await expect(runSmoke({}, { log: () => {} })).rejects.toThrow(/OVERTIME_LLM_BASE_URL/);
  });
});
