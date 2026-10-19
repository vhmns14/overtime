// Replay export: composes the office canvas, the DOM overlays (name tags, speech bubbles, the "?" of
// a stuck agent), a caption (task + cost) and a small "made with Overtime" corner into one frame,
// then records frames as a GIF (gif.ts) or a WebM/MP4 (MediaRecorder on a captured canvas).

import { GifEncoder } from "./gif";

export interface Caption { title: string; meta: string; clock: string }

export interface FrameOpts {
  caption: boolean;
  corner: boolean;
}

const FONT_SANS = '"Inter", ui-sans-serif, system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

/** Output size: the office's aspect, at most maxW wide, even dimensions (video encoders like that). */
export function exportSize(srcW: number, srcH: number, maxW: number, captionH: number): { w: number; h: number; scale: number; officeH: number } {
  const scale = Math.min(1, maxW / Math.max(1, srcW));
  const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const officeH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  return { w, h: officeH + captionH, scale, officeH };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function fit(c: CanvasRenderingContext2D, text: string, max: number): string {
  if (c.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.measureText(text.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + "…";
}

/** Reads an element's translate(x, y) (how the office positions its overlays). */
function translateOf(el: HTMLElement): { x: number; y: number } | null {
  const m = el.style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

export class FrameComposer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly size: ReturnType<typeof exportSize>;
  readonly captionH: number;

  constructor(private office: HTMLElement, maxW: number, private opts: FrameOpts) {
    const src = office.querySelector<HTMLCanvasElement>(".office-canvas")!;
    const cssW = src.clientWidth || src.width, cssH = src.clientHeight || src.height;
    this.captionH = opts.caption ? Math.round(Math.min(maxW, cssW) * 0.085 + 16) : 0;
    this.size = exportSize(cssW, cssH, maxW, this.captionH);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.size.w;
    this.canvas.height = this.size.h;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  draw(cap: Caption) {
    const c = this.ctx;
    const { w, officeH, scale } = this.size;
    const src = this.office.querySelector<HTMLCanvasElement>(".office-canvas")!;
    c.imageSmoothingEnabled = false;
    c.fillStyle = "#0b0908";
    c.fillRect(0, 0, w, this.size.h);
    c.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, officeH);
    // overlays: tags and bubbles, in the office's stacking order
    const actors = [...this.office.querySelectorAll<HTMLElement>(".office-layer .actor")].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
    const fs = Math.max(9, Math.round(12.5 * Math.max(0.62, scale)));
    for (const a of actors) {
      const p = translateOf(a);
      if (!p) continue;
      const x = p.x * scale, y = p.y * scale;
      const tag = a.querySelector<HTMLElement>(".tag");
      const stuck = a.classList.contains("is-stuck");
      if (tag?.textContent) {
        c.font = `500 ${fs}px ${FONT_SANS}`;
        const tw = c.measureText(tag.textContent).width + 10;
        const th = fs + 8;
        roundRect(c, x - tw / 2, y - th - 4, tw, th, 4);
        c.fillStyle = a.classList.contains("is-waiting") ? "#e8742f" : "rgba(28,22,18,.86)";
        c.fill();
        c.fillStyle = a.classList.contains("is-waiting") ? "#1b0f06" : "#fff";
        c.textBaseline = "middle";
        c.fillText(tag.textContent, x - tw / 2 + 5, y - th / 2 - 4);
      }
      const bub = a.querySelector<HTMLElement>(".bubble");
      if (bub && !bub.hidden && bub.textContent) {
        c.font = `500 ${fs}px ${FONT_MONO}`;
        const text = fit(c, bub.textContent, Math.max(80, 200 * scale));
        const bw = c.measureText(text).width + 14, bh = fs + 12;
        const by = y - fs - 8 - (stuck ? 62 : 30) * Math.max(0.6, scale) - bh;
        roundRect(c, x - bw / 2, by, bw, bh, 5);
        const wait = bub.dataset.kind === "wait";
        c.fillStyle = wait ? "#e8742f" : "#fffdf8";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "#141210";
        c.stroke();
        c.fillStyle = wait ? "#1b0f06" : "#141210";
        c.textBaseline = "middle";
        c.fillText(text, x - bw / 2 + 7, by + bh / 2);
      }
      if (stuck) {
        const r = Math.max(8, 11 * scale);
        const qy = y - 4 - 36 * Math.max(0.6, scale) + r;
        c.beginPath();
        c.arc(x, qy - r, r, 0, Math.PI * 2);
        c.fillStyle = "#b03a1e";
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = "#141210";
        c.stroke();
        c.fillStyle = "#fff";
        c.font = `700 ${Math.round(r * 1.4)}px ${FONT_SANS}`;
        c.textAlign = "center";
        c.fillText("?", x, qy - r + 1);
        c.textAlign = "left";
      }
    }
    if (this.opts.corner) {
      c.font = `600 ${Math.max(9, Math.round(11 * Math.max(0.7, scale)))}px ${FONT_MONO}`;
      const t = "made with Overtime";
      const tw = c.measureText(t).width + 12, th = Math.max(9, Math.round(11 * Math.max(0.7, scale))) + 10;
      roundRect(c, w - tw - 8, 8, tw, th, 4);
      c.fillStyle = "rgba(15,11,9,.78)";
      c.fill();
      c.fillStyle = "#f6e7cf";
      c.textBaseline = "middle";
      c.fillText(t, w - tw - 2, 8 + th / 2);
    }
    if (this.opts.caption) {
      const y0 = officeH, h = this.captionH;
      c.fillStyle = "#f3eee4";
      c.fillRect(0, y0, w, h);
      c.fillStyle = "#e8742f";
      c.fillRect(0, y0, w, 3);
      const pad = Math.round(h * 0.22);
      c.textBaseline = "alphabetic";
      c.fillStyle = "#141210";
      c.font = `700 ${Math.round(h * 0.3)}px ${FONT_SANS}`;
      const clockW = (() => { c.font = `600 ${Math.round(h * 0.26)}px ${FONT_MONO}`; return c.measureText(cap.clock).width; })();
      c.font = `700 ${Math.round(h * 0.3)}px ${FONT_SANS}`;
      c.fillText(fit(c, cap.title, w - pad * 3 - clockW), pad, y0 + h * 0.47);
      c.fillStyle = "#3b352d";
      c.font = `500 ${Math.round(h * 0.24)}px ${FONT_MONO}`;
      c.fillText(fit(c, cap.meta, w - pad * 2), pad, y0 + h * 0.82);
      c.fillStyle = "#141210";
      c.font = `600 ${Math.round(h * 0.26)}px ${FONT_MONO}`;
      c.fillText(cap.clock, w - pad - clockW, y0 + h * 0.47);
    }
  }

  pixels(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.size.w, this.size.h).data;
  }
}

export type VideoKind = "webm" | "mp4";

/** The best MediaRecorder type for a container, or null when the browser cannot record it. */
export function pickMime(kind: VideoKind): string | null {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return null;
  const list = kind === "mp4" ? ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"] : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((t) => MR.isTypeSupported(t)) ?? null;
}

export interface Recorder {
  frame(cap: Caption, realMs: number): void;
  finish(): Promise<Blob>;
  cancel(): void;
}

/** GIF: one composed frame every 1000/fps ms, encoded as it goes (no frame buffer). */
export function gifRecorder(composer: FrameComposer, fps = 10): Recorder {
  const { w, h } = composer.size;
  const enc = new GifEncoder(w, h);
  let since = Infinity, first = true;
  const step = 1000 / fps;
  return {
    frame(cap, realMs) {
      since += realMs;
      if (since < step && !first) return;
      composer.draw(cap);
      const px = composer.pixels();
      if (first) enc.setPalette([px]);
      enc.addFrame(px, first ? step : Math.min(since, step * 3));
      since = 0;
      first = false;
    },
    async finish() {
      return new Blob([enc.finish() as BlobPart], { type: "image/gif" });
    },
    cancel() { /* nothing to release */ },
  };
}

/** WebM/MP4: MediaRecorder on the composer canvas' captured stream. */
export function videoRecorder(composer: FrameComposer, mime: string, fps = 30, bitsPerSecond = 2_000_000): Recorder {
  const stream = (composer.canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  return {
    frame(cap) { composer.draw(cap); },
    finish() {
      return new Promise<Blob>((resolve) => {
        rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type: mime.split(";")[0] })); };
        // one last frame so the final state is in the clip
        setTimeout(() => rec.state !== "inactive" ? rec.stop() : resolve(new Blob(chunks, { type: mime.split(";")[0] })), 300);
      });
    },
    cancel() { try { rec.stop(); } catch { /* */ } stream.getTracks().forEach((t) => t.stop()); },
  };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
