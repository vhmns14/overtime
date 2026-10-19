// DEMO 2: "Fix a bug in an existing repo → PR". A recorded run against a fake repo
// (kodekecil/warung-cart) served by the in-memory FakeGitHub. It goes through the real repo
// pipeline: the PM reads the real tree, Research reads files lazily, the Coder patches with
// search/replace edits, the Reviewer's JS syntax check catches a missing parenthesis, the Coder
// fixes it, and Ops opens a real (fake-API) pull request on a fresh overtime/… branch.

import type { CompletionRequest } from "../engine/types";
import { FakeGitHub, type FakeRepoSeed } from "./fake-github";
import readme from "./repo/README.md?raw";
import pkg from "./repo/package.json?raw";
import cart from "./repo/cart.mjs?raw";
import format from "./repo/format.mjs?raw";
import index from "./repo/index.mjs?raw";
import cartTest from "./repo/cart.test.mjs?raw";
import ci from "./repo/ci.yml?raw";

export const DEMO_REPO = "kodekecil/warung-cart";
export const DEMO_REPO_BRANCH = "main";
export const DEMO_REPO_TASK = "Fix: cart total ignores item quantity (issue #7)";
export const DEMO_GH_TOKEN = "demo-token-not-a-secret";

export const DEMO_REPO_SEED: FakeRepoSeed = {
  full_name: DEMO_REPO,
  default_branch: DEMO_REPO_BRANCH,
  description: "Cart math for a warung point-of-sale",
  protectedBranches: ["main"],
  files: {
    "README.md": readme,
    "package.json": pkg,
    "src/cart.mjs": cart,
    "src/format.mjs": format,
    "src/index.mjs": index,
    "test/cart.test.mjs": cartTest,
    ".github/workflows/ci.yml": ci,
    // ignored by the tree loader: lockfile, vendored deps, binary
    "package-lock.json": '{\n  "name": "warung-cart",\n  "lockfileVersion": 3\n}\n',
    "node_modules/left-pad/index.js": "export default (s, n) => String(s).padStart(n);\n",
    "docs/receipt.png": "\u0089PNG fake",
  },
};

export function demoGitHub(latencyMs = 0) {
  const gh = new FakeGitHub(DEMO_GH_TOKEN, "kodekecil", [DEMO_REPO_SEED, { full_name: "kodekecil/kopi-senja", files: { "index.html": "<!doctype html><title>Kopi Senja</title>\n" } }]);
  gh.latencyMs = latencyMs;
  return gh;
}

const BUGGY_LINE = "  return item.price * (item.qty ?? 1;";
const FIXED_LINE = "  return item.price * (item.qty ?? 1);";

const NEW_TEST = `

test("subtotal multiplies the price by the quantity (issue #7)", () => {
  assert.equal(subtotal([{ name: "Gorengan", price: 2000, qty: 5 }, { name: "Es teh", price: 5000 }]), 15000);
});
`;

const j = (thought: string, tool: string, args: Record<string, unknown>) => JSON.stringify({ thought, tool, args });

export function demoRepoReply(req: CompletionRequest): string {
  const step = req.messages.filter((m) => m.role === "assistant").length;
  const first = req.messages[1]?.content ?? "";
  const feedback = /FEEDBACK FROM THE HUMAN/.test(first);
  const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  switch (req.agent) {
    case "pm":
      if (step === 0) return j("README says #7: qty is ignored. Opening the cart math.", "read_file", { path: "src/cart.mjs" });
      return j(
        feedback ? "Tightened the plan around your note." : "lineTotal() never looks at qty. Small fix plus a regression test.",
        "handoff",
        {
          to: "research",
          summary: "Bug is in src/cart.mjs lineTotal(); add a test in test/cart.test.mjs.",
          plan: "1. Confirm the root cause in src/cart.mjs (lineTotal returns item.price and ignores item.qty).\n2. Multiply by qty, defaulting to 1 so existing callers keep working.\n3. Add a regression test for issue #7 in test/cart.test.mjs.\n4. Run checks, then open one PR against main.",
          files: ["src/cart.mjs", "test/cart.test.mjs"],
          tickets: [
            { id: "T1", title: "Confirm root cause in src/cart.mjs", owner: "research" },
            { id: "T2", title: "lineTotal: price × qty (default 1)", owner: "coder" },
            { id: "T3", title: "Regression test in test/cart.test.mjs", owner: "coder" },
            { id: "T4", title: "Checks: syntax, package.json, risk", owner: "reviewer" },
            { id: "T5", title: "Open PR against main", owner: "ops" },
          ],
        },
      );
    case "research":
      if (step === 0) return j("Reading the existing tests to match their style.", "read_file", { path: "test/cart.test.mjs" });
      if (step === 1) return j("Who else calls lineTotal?", "search_repo", { query: "lineTotal" });
      return j("Root cause confirmed. Only subtotal() calls lineTotal().", "handoff", {
        to: "coder",
        summary: "lineTotal() returns item.price; subtotal() is its only caller.",
        brief: "Root cause: src/cart.mjs line 5, lineTotal(item) returns item.price and ignores item.qty.\nFix: return item.price * (item.qty ?? 1) so items without qty still count once.\nTests: test/cart.test.mjs uses node:test + assert/strict, one test() per behaviour, Indonesian item names. Add one test: 5 gorengan at 2000 + 1 es teh at 5000 = 15000.\nsrc/index.mjs re-exports lineTotal; no other callers.",
      });
    case "coder": {
      if (/FIX ROUND/.test(first)) {
        if (step === 0) return j("Missing parenthesis on line 5. Patching it.", "edit_file", { path: "src/cart.mjs", edits: [{ search: BUGGY_LINE, replace: FIXED_LINE }], ticket: "T2" });
        return j("Syntax fixed. Back to Reviewer.", "handoff", { to: "reviewer", summary: "Closed the parenthesis in lineTotal()." });
      }
      if (step === 0) return j("Reading src/cart.mjs before patching.", "read_file", { path: "src/cart.mjs" });
      if (step === 1) return j("Multiply by qty, default 1.", "edit_file", { path: "src/cart.mjs", edits: [{ search: "  return item.price;", replace: BUGGY_LINE }], ticket: "T2" });
      if (step === 2) return j("Adding the regression test for #7.", "edit_file", { path: "test/cart.test.mjs", edits: [{ search: "9990);\n});\n", replace: `9990);\n});${NEW_TEST}` }], ticket: "T3" });
      return j("Fix and test are in. Sending to review.", "handoff", { to: "reviewer", summary: "lineTotal() now uses qty; new regression test." });
    }
    case "reviewer": {
      if (!/TOOL RESULT \(run_checks\)/.test(last)) return j("Running checks on the changed files.", "run_checks", {});
      let ok = true;
      try { ok = JSON.parse(last.slice(last.indexOf("{"))).ok; } catch { ok = !/"ok":false/.test(last); }
      if (ok) return j("Syntax and package checks pass, no risky files. Over to Ops.", "handoff", { to: "ops", verdict: "pass", summary: "All checks pass on 2 changed files; no risk flags." });
      return j("src/cart.mjs does not parse: a parenthesis is never closed.", "handoff", {
        to: "coder", verdict: "fix",
        summary: "1 failing: JavaScript syntax in src/cart.mjs.",
        fixes: ["src/cart.mjs:5 close the parenthesis: item.price * (item.qty ?? 1)"],
      });
    }
    case "ops":
      if (step === 0) return j("Listing the staged changes.", "list_files", { prefix: "src/" });
      return j("One commit, new branch, PR against main.", "finish", { summary: "2 files: fix in src/cart.mjs, regression test in test/cart.test.mjs.", title: "Fix cart subtotal ignoring item quantity (#7)" });
  }
}
