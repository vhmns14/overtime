// A tiny PNG reader for tests: 8-bit, non-interlaced, colour types 2 (RGB), 3 (palette) and 6 (RGBA).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface Png { w: number; h: number; px: Uint8Array /* RGBA */ }

export function readPng(path: string): Png {
  const b = readFileSync(path);
  const u32 = (a: Uint8Array, i: number) => ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;
  let o = 8, w = 0, h = 0, type = 0, plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (o < b.length) {
    const len = u32(b, o), kind = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), d = b.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") {
      w = u32(d, 0); h = u32(d, 4); type = d[9];
      if (d[8] !== 8 || d[12] !== 0 || ![2, 3, 6].includes(type)) throw new Error(`unsupported PNG ${path}`);
    } else if (kind === "PLTE") plte = d;
    else if (kind === "tRNS") trns = d;
    else if (kind === "IDAT") idat.push(d);
    else if (kind === "IEND") break;
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 1, stride = w * bpp;
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((at, d) => (all.set(d, at), at + d.length), 0);
  const raw = inflateSync(all);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride), px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      if (type === 3) { const k = cur[x]; px[q] = plte![k * 3]; px[q + 1] = plte![k * 3 + 1]; px[q + 2] = plte![k * 3 + 2]; px[q + 3] = trns && k < trns.length ? trns[k] : 255; }
      else { px[q] = cur[x * bpp]; px[q + 1] = cur[x * bpp + 1]; px[q + 2] = cur[x * bpp + 2]; px[q + 3] = type === 6 ? cur[x * bpp + 3] : 255; }
    }
    prev.set(cur);
  }
  return { w, h, px };
}

export const rgba = (p: Png, x: number, y: number) => { const q = (Math.round(y) * p.w + Math.round(x)) * 4; return [p.px[q], p.px[q + 1], p.px[q + 2], p.px[q + 3]]; };
