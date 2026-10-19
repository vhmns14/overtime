// Wires a GitHub client into the orchestrator's repo-mode hooks. The PR is built on the exact commit
// the agents read (the snapshot sha), never on a newer head they did not see.
import type { GitHubClient } from "./github";
import { RepoFS, githubSource, loadSnapshot } from "./repo";
import type { OrchestratorDeps } from "./orchestrator";
import type { RepoTarget } from "./types";

export function repoDeps(gh: GitHubClient, target: RepoTarget, opts: { dryRun?: boolean; shortId?: () => string } = {}): Pick<OrchestratorDeps, "loadRepo" | "openPR"> {
  let baseSha = "";
  return {
    loadRepo: async () => {
      const snap = await loadSnapshot(gh, target.repo, target.branch);
      baseSha = snap.sha;
      return new RepoFS(snap, githubSource(gh, target.repo));
    },
    openPR: opts.dryRun
      ? undefined
      : (p) => gh.openPullRequest({ repo: target.repo, base: target.branch, baseSha: baseSha || undefined, shortId: opts.shortId, ...p }),
  };
}
