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

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Unified-diff hunks (git style, `context` lines around each change). */
export function hunks(a: string, b: string, context = 3): Hunk[] {
  const lines = lineDiff(a, b);
  const out: Hunk[] = [];
  // line numbers before each diff line
  let o = 1, n = 1;
  const pos = lines.map((l) => {
    const p = { o, n };
    if (l.type !== "add") o++;
    if (l.type !== "del") n++;
    return p;
  });
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "ctx") { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    // extend while the next change is within 2*context lines
    for (let j = i; j < lines.length; j++) {
      if (lines[j].type !== "ctx") end = j;
      else if (j - end > context * 2) break;
    }
    const stop = Math.min(lines.length - 1, end + context);
    const slice = lines.slice(start, stop + 1);
    const h: Hunk = {
      oldStart: pos[start].o,
      newStart: pos[start].n,
      oldLines: slice.filter((l) => l.type !== "add").length,
      newLines: slice.filter((l) => l.type !== "del").length,
      lines: slice,
    };
    if (h.oldLines === 0) h.oldStart--;
    if (h.newLines === 0) h.newStart--;
    out.push(h);
    i = stop + 1;
    start = i;
  }
  return out;
}

/** A git-style unified diff for one file. `a` undefined = added file, `b` undefined = deleted file. */
export function unifiedDiff(path: string, a: string | undefined, b: string | undefined, context = 3): string {
  const from = a === undefined ? "/dev/null" : `a/${path}`;
  const to = b === undefined ? "/dev/null" : `b/${path}`;
  const hs = hunks(a ?? "", b ?? "", context);
  if (!hs.length) return "";
  const head = [`diff --git a/${path} b/${path}`, a === undefined ? "new file mode 100644" : b === undefined ? "deleted file mode 100644" : "", `--- ${from}`, `+++ ${to}`].filter(Boolean);
  const body = hs.flatMap((h) => [
    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    ...h.lines.map((l) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.text),
  ]);
  return [...head, ...body].join("\n");
}
