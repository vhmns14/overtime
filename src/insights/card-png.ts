// The session summary card as a shareable PNG: drawn on a canvas in Overtime's editorial style.

import type { SessionStats } from "./aggregate";
import { fmtDuration, fmtTokens, fmtUsd, STATUS_LABEL, whatWasDone } from "./summary";

const SANS = '"Inter", ui-sans-serif, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const C = { paper: "#f3eee4", card: "#fffdf8", ink: "#141210", ink2: "#3b352d", muted: "#6c6355", line: "#d6cdbd", accent: "#e8742f", bad: "#b03a1e", good: "#2f6b2a" };

function wrap(c: CanvasRenderingContext2D, text: string, max: number, maxLines = 3): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (c.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    let l = lines[maxLines - 1];
    while (l && c.measureText(l + "…").width > max) l = l.slice(0, -1);
    lines[maxLines - 1] = l + "…";
  }
  return lines;
}

function fit(c: CanvasRenderingContext2D, text: string, max: number) {
  if (c.measureText(text).width <= max) return text;
  let t = text;
  while (t && c.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** Draws the card; returns the canvas (1200 wide, height to fit). */
export function drawSummaryCard(s: SessionStats, opts: { aiSummary?: string; when?: string } = {}): HTMLCanvasElement {
  const W = 1200, P = 56;
  const cv = document.createElement("canvas");
  const measure = cv.getContext("2d")!;
  measure.font = `500 24px ${SANS}`;
  const done = whatWasDone(s).slice(0, 6);
  const doneLines = done.map((d) => wrap(measure, d, W - P * 2 - 40, 2));
  measure.font = `italic 400 24px ${SANS}`;
  const aiLines = opts.aiSummary ? wrap(measure, opts.aiSummary, W - P * 2 - 40, 4) : [];
  const cols = Math.max(Math.min(6, s.files.length), Math.min(6, s.tools.length), s.errors.length ? Math.min(3, s.errors.length) + 1 : 0);
  const H = 300 + (aiLines.length ? aiLines.length * 34 + 40 : 0) + 56 + doneLines.reduce((a, l) => a + l.length * 32 + 10, 0) + (cols ? 70 + cols * 34 : 0) + 110;
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#0b0908";
  c.fillRect(0, 0, W, H);
  c.fillStyle = C.paper;
  c.fillRect(14, 14, W - 28, H - 28);
  c.fillStyle = C.accent;
  c.fillRect(14, 14, W - 28, 10);
  let y = 86;
  c.textBaseline = "alphabetic";
  c.fillStyle = C.muted;
  c.font = `600 18px ${MONO}`;
  c.fillText(`HERMES SESSION${opts.when ? ` · ${opts.when.toUpperCase()}` : ""}`, P, y);
  // status pill
  const st = STATUS_LABEL[s.status].toUpperCase();
  c.font = `700 17px ${MONO}`;
  const pw = c.measureText(st).width + 24;
  c.fillStyle = s.status === "failed" ? C.bad : s.status === "open" ? C.accent : C.ink;
  c.fillRect(W - P - pw, y - 22, pw, 32);
  c.fillStyle = s.status === "open" ? C.ink : C.paper;
  c.fillText(st, W - P - pw + 12, y);
  y += 58;
  c.fillStyle = C.ink;
  c.font = `700 44px ${SANS}`;
  c.fillText(fit(c, s.title, W - P * 2), P, y);
  y += 40;
  // stats row
  const stats: [string, string][] = [["Duration", fmtDuration(s.durationMs)], ["Cost", fmtUsd(s.usd) + (s.unpriced.length ? "+" : "")], ["Tokens", fmtTokens(s.tokens.total)], ["Model calls", String(s.calls)], ["Tools", String(s.tools.reduce((a, t) => a + t.count, 0))]];
  const cw = (W - P * 2) / stats.length;
  stats.forEach(([k, v], i) => {
    const x = P + i * cw;
    c.fillStyle = C.card;
    c.fillRect(x, y, cw - 14, 96);
    c.strokeStyle = C.ink;
    c.lineWidth = 3;
    c.strokeRect(x + 1.5, y + 1.5, cw - 17, 93);
    c.fillStyle = C.muted;
    c.font = `600 15px ${MONO}`;
    c.fillText(k.toUpperCase(), x + 16, y + 30);
    c.fillStyle = C.ink;
    c.font = `700 34px ${MONO}`;
    c.fillText(fit(c, v, cw - 44), x + 16, y + 74);
  });
  y += 132;
  c.fillStyle = C.ink2;
  c.font = `500 18px ${MONO}`;
  c.fillText(fit(c, `Models: ${s.models.join(", ") || "unknown"}`, W - P * 2), P, y - 8);
  if (aiLines.length) {
    y += 22;
    c.fillStyle = C.accent;
    c.fillRect(P, y - 26, 5, aiLines.length * 34 + 8);
    c.fillStyle = C.ink;
    c.font = `italic 400 24px ${SANS}`;
    for (const l of aiLines) { c.fillText(l, P + 22, y); y += 34; }
    y += 6;
  }
  y += 34;
  c.fillStyle = C.ink;
  c.font = `700 18px ${MONO}`;
  c.fillText("WHAT WAS DONE", P, y);
  y += 38;
  c.font = `500 24px ${SANS}`;
  for (const lines of doneLines) {
    c.fillStyle = C.accent;
    c.fillRect(P + 4, y - 14, 10, 10);
    c.fillStyle = C.ink;
    for (const l of lines) { c.fillText(l, P + 34, y); y += 32; }
    y += 10;
  }
  if (cols) {
    y += 22;
    const third = (W - P * 2) / 3;
    const col = (x: number, title: string, rows: string[], color = C.ink) => {
      c.fillStyle = C.ink;
      c.font = `700 16px ${MONO}`;
      c.fillText(title, x, y);
      c.font = `500 19px ${MONO}`;
      c.fillStyle = color;
      rows.forEach((r, i) => c.fillText(fit(c, r, third - 24), x, y + 40 + i * 34));
    };
    col(P, "FILES CHANGED", s.files.length ? s.files.slice(0, 6).map((f) => `${f.op === "delete" ? "−" : f.count > 1 || f.op !== "write" ? "~" : "+"} ${f.path.split("/").slice(-2).join("/")}`) : ["none"]);
    col(P + third, "TOP TOOLS", s.tools.length ? s.tools.slice(0, 6).map((t) => `${t.name} ×${t.count}${t.fails ? ` (${t.fails}✗)` : ""}`) : ["none"]);
    col(P + third * 2, `ERRORS · ${s.errors.length}`, s.errors.length ? s.errors.slice(0, 3).map((e) => e.text) : ["none"], s.errors.length ? C.bad : C.ink);
    y += 40 + cols * 34;
  }
  // footer
  c.fillStyle = C.line;
  c.fillRect(P, H - 92, W - P * 2, 2);
  c.fillStyle = C.ink2;
  c.font = `500 17px ${MONO}`;
  c.fillText(`${fmtTokens(s.tokens.input)} in · ${fmtTokens(s.tokens.output)} out · ${fmtTokens(s.tokens.cacheRead)} cache`, P, H - 54);
  c.fillStyle = C.ink;
  c.font = `700 18px ${MONO}`;
  const mark = "made with Overtime";
  c.fillText(mark, W - P - c.measureText(mark).width, H - 54);
  c.fillStyle = C.accent;
  c.fillRect(W - P - c.measureText(mark).width - 22, H - 68, 12, 12);
  return cv;
}

export function canvasBlob(cv: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the PNG"))), "image/png");
    } catch (e) { reject(e as Error); }
  });
}
