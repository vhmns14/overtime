// Tiny chart helpers for the cost dashboard: SVG strings and HTML bars, no chart library.

export interface Bar { label: string; value: number; title?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A "nice" axis maximum: 1, 2, 2.5 or 5 × 10^k at or above v. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Vertical bar chart (one bar per day) with an optional dashed limit line. */
export function barChart(bars: Bar[], opts: { w?: number; h?: number; fmt: (v: number) => string; limit?: number | null; label?: string }): string {
  const W = opts.w ?? 560, H = opts.h ?? 180;
  const padL = 46, padR = 8, padT = 12, padB = 24;
  const max = niceMax(Math.max(...bars.map((b) => b.value), opts.limit ?? 0, 0));
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = iw / Math.max(1, bars.length);
  const y = (v: number) => padT + ih - (v / max) * ih;
  const every = Math.ceil(bars.length / 7);
  let g = "";
  for (const f of [0, 0.5, 1]) {
    const yy = y(max * f);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="ch-grid"/><text x="${padL - 6}" y="${(yy + 4).toFixed(1)}" class="ch-axis" text-anchor="end">${esc(opts.fmt(max * f))}</text>`;
  }
  bars.forEach((b, i) => {
    const x = padL + i * bw + bw * 0.15, h = Math.max(b.value > 0 ? 1.5 : 0, (b.value / max) * ih);
    const over = opts.limit && b.value >= opts.limit;
    g += `<rect x="${x.toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" class="ch-bar${over ? " is-over" : ""}${i === bars.length - 1 ? " is-last" : ""}"><title>${esc(b.title ?? `${b.label}: ${opts.fmt(b.value)}`)}</title></rect>`;
    if (i % every === 0 || i === bars.length - 1) g += `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 7}" class="ch-axis" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (opts.limit) {
    const yy = y(opts.limit);
    g += `<line x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="ch-limit"/><text x="${W - padR}" y="${(yy - 4).toFixed(1)}" class="ch-axis ch-limit-t" text-anchor="end">limit ${esc(opts.fmt(opts.limit))}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label ?? "chart")}" preserveAspectRatio="none">${g}</svg>`;
}

/** Horizontal bars as HTML rows: label, bar, value. */
export function hBars(bars: Bar[], fmt: (v: number) => string, opts: { sub?: (i: number) => string; attr?: (i: number) => string } = {}): string {
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  return `<ol class="hbars">${bars.map((b, i) => `<li ${opts.attr?.(i) ?? ""}><span class="hb-l" title="${esc(b.title ?? b.label)}">${esc(b.label)}</span><span class="hb-bar"><i style="width:${((b.value / max) * 100).toFixed(1)}%"></i></span><span class="hb-v">${esc(fmt(b.value))}${opts.sub ? `<small>${esc(opts.sub(i))}</small>` : ""}</span></li>`).join("")}</ol>`;
}

/** One stacked bar (tokens by kind) with a legend. */
export function stackBar(parts: { label: string; value: number; cls: string }[], fmt: (v: number) => string): string {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return `<div class="stack" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${fmt(p.value)}`).join(", "))}">${parts.filter((p) => p.value > 0).map((p) => `<i class="${p.cls}" style="width:${((p.value / total) * 100).toFixed(2)}%" title="${esc(`${p.label}: ${fmt(p.value)}`)}"></i>`).join("")}</div>
    <ul class="stack-legend">${parts.map((p) => `<li><i class="${p.cls}"></i>${esc(p.label)} <b>${esc(fmt(p.value))}</b></li>`).join("")}</ul>`;
}
