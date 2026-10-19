// The Reviewer's checks in repo mode: real checks on the changed files only, plus risk flags that
// force a human approval before a pull request is opened.

import { runChecks, defaultSyntax, basicSyntax, type SyntaxChecker } from "./checks";
import { isLockfile, type FileChange } from "./repo";
import type { CheckReport, CheckResult } from "./types";

export interface RiskFlag { id: string; path: string; reason: string }
export interface RepoReport extends CheckReport { risks: RiskFlag[] }

export interface RepoCheckOptions {
  syntax?: SyntaxChecker;
  /** a deletion of more than this many lines in one file is flagged */
  maxDeletedLines?: number;
  /** lockfile edits touching more than this many lines are flagged as mass edits */
  maxLockfileLines?: number;
}

const JS = /\.(m|c)?jsx?$/i;
const TS = /\.(m|c)?tsx?$/i;
const SECRET_PATH = /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|[^/]+\.(pem|key|p12|pfx))$/i;
const SECRET_TEXT = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,})/;

/** Removes TS-only syntax well enough for a bracket/string balance check (no type checking). */
function tsBalance(code: string): string | null {
  return basicSyntax(code);
}

export function validatePackageJson(text: string): string[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return [`invalid JSON: ${(e as Error).message}`];
  }
  const errs: string[] = [];
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return ["must be a JSON object"];
  const p = pkg as Record<string, unknown>;
  if (p.name !== undefined && (typeof p.name !== "string" || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(p.name))) errs.push(`"name" is not a valid package name`);
  if (p.version !== undefined && (typeof p.version !== "string" || !/^\d+\.\d+\.\d+/.test(p.version))) errs.push(`"version" is not semver`);
  for (const k of ["scripts", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const v = p[k];
    if (v === undefined) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) { errs.push(`"${k}" must be an object`); continue; }
    for (const [name, spec] of Object.entries(v)) if (typeof spec !== "string") errs.push(`"${k}.${name}" must be a string`);
  }
  return errs;
}

export function riskFlags(changes: FileChange[], o: RepoCheckOptions = {}): RiskFlag[] {
  const maxDel = o.maxDeletedLines ?? 200;
  const maxLock = o.maxLockfileLines ?? 50;
  const out: RiskFlag[] = [];
  for (const c of changes) {
    if (/^\.github\//.test(c.path)) out.push({ id: "workflow", path: c.path, reason: "changes CI/workflow or repo config under .github/" });
    if (SECRET_PATH.test(c.path)) out.push({ id: "secrets", path: c.path, reason: "touches a secrets/credentials file" });
    if (c.after && SECRET_TEXT.test(c.after) && !(c.before && SECRET_TEXT.test(c.before))) out.push({ id: "secret-text", path: c.path, reason: "added text that looks like a token or private key" });
    if (isLockfile(c.path) && c.added + c.removed > maxLock) out.push({ id: "lockfile", path: c.path, reason: `mass lockfile edit (${c.added + c.removed} lines)` });
    if (c.status === "deleted") out.push({ id: "delete", path: c.path, reason: "deletes the file" });
    else if (c.removed > maxDel) out.push({ id: "big-delete", path: c.path, reason: `deletes ${c.removed} lines` });
  }
  return out;
}

export function runRepoChecks(changes: FileChange[], allFiles: Record<string, string>, o: RepoCheckOptions = {}): RepoReport {
  const syntax = o.syntax ?? defaultSyntax;
  const live = changes.filter((c) => c.status !== "deleted" && c.after !== undefined);
  const results: CheckResult[] = [];
  const push = (id: string, label: string, details: string[], level: "fail" | "warn" = "fail") => results.push({ id, label, status: details.length ? level : "pass", details });

  const jsErr: string[] = [];
  for (const c of live.filter((c) => JS.test(c.path))) {
    const e = syntax(c.after!);
    if (e) jsErr.push(`${c.path}: ${e}`);
  }
  const tsErr: string[] = [];
  for (const c of live.filter((c) => TS.test(c.path))) {
    const e = tsBalance(c.after!);
    if (e) tsErr.push(`${c.path}: ${e}`);
  }
  const jsonErr: string[] = [];
  for (const c of live.filter((c) => /\.json$/i.test(c.path) && !/(^|\/)tsconfig[^/]*\.json$/i.test(c.path))) {
    if (/(^|\/)package\.json$/.test(c.path)) for (const e of validatePackageJson(c.after!)) jsonErr.push(`${c.path}: ${e}`);
    else try { JSON.parse(c.after!); } catch (e) { jsonErr.push(`${c.path}: invalid JSON (${(e as Error).message})`); }
  }
  if (live.some((c) => JS.test(c.path))) push("js", "JavaScript syntax (changed files)", jsErr);
  if (live.some((c) => TS.test(c.path))) push("ts", "TypeScript balance check (changed files)", tsErr);
  if (live.some((c) => /\.json$/i.test(c.path))) push("json", "JSON / package.json valid", jsonErr);

  // the site checks for changed HTML/CSS, judged only on what changed
  const web = live.filter((c) => /\.(html?|css)$/i.test(c.path));
  if (web.length) {
    const rep = runChecks(allFiles, { syntax });
    const changed = new Set(web.map((c) => c.path));
    for (const r of rep.results) {
      if (["size", "meta", "js"].includes(r.id)) continue;
      const details = r.details.filter((d) => [...changed].some((p) => d.startsWith(p + ":") || d.startsWith(p + " ")));
      if (r.id === "links" && details.length === 0 && r.details.some((d) => /index\.html is missing/.test(d))) continue;
      results.push({ ...r, status: details.length ? r.status : "pass", details });
    }
  }
  const risks = riskFlags(changes, o);
  push("risk", "Risky changes (need your approval)", risks.map((r) => `${r.path}: ${r.reason}`), "warn");
  if (!changes.length) push("changes", "There are changes to commit", ["no file was changed"]);
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  const totalBytes = live.reduce((n, c) => n + (c.after?.length ?? 0), 0);
  return { ok: failures === 0, failures, warnings, results, totalBytes, risks };
}
