// Line diff (LCS) used by the files view and the approval card.
import type { DiffLine } from "./types";

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) {
    // too big for LCS: whole-file replace
    return [...x.map((t) => ({ type: "del" as const, text: t })), ...y.map((t) => ({ type: "add" as const, text: t }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ type: "ctx", text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: x[i++] });
    else out.push({ type: "add", text: y[j++] });
  }
  while (i < n) out.push({ type: "del", text: x[i++] });
  while (j < m) out.push({ type: "add", text: y[j++] });
  return out;
}

/** Keeps only changed lines plus `context` lines around them; gaps become a "…" context line. */
export function compactDiff(lines: DiffLine[], context = 1): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== "ctx") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep[i]) { out.push(l); gap = false; }
    else if (!gap) { out.push({ type: "ctx", text: "…" }); gap = true; }
  });
  return out;
}

export function diffStats(lines: DiffLine[]) {
  return { added: lines.filter((l) => l.type === "add").length, removed: lines.filter((l) => l.type === "del").length };
}
