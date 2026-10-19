// A small animated-GIF (GIF89a) encoder, written for Overtime's replay export. MIT, no deps.
// - one global palette (median cut over sample frames, 255 colours + 1 transparent index)
// - inter-frame compression: pixels that did not change become transparent and each frame is
//   cropped to the box that changed (disposal "do not dispose"), so a mostly static office stays small
// - identical frames are merged into a longer delay
// - LZW with the usual 12-bit dictionary and clear codes

export type RGBA = Uint8ClampedArray | Uint8Array;

const TRANSPARENT = 255;

class Bytes {
  buf = new Uint8Array(1 << 16);
  n = 0;
  private grow(k: number) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  byte(v: number) { this.grow(1); this.buf[this.n++] = v & 255; }
  u16(v: number) { this.byte(v); this.byte(v >> 8); }
  bytes(a: ArrayLike<number>) { this.grow(a.length); for (let i = 0; i < a.length; i++) this.buf[this.n++] = a[i]; }
  str(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  out() { return this.buf.slice(0, this.n); }
}

/** Median-cut palette (up to `max` colours) from RGBA samples. Returns [r,g,b,…]. */
export function medianCut(samples: RGBA[], max = 255): Uint8Array {
  const hist = new Uint32Array(32768);
  for (const px of samples) {
    const step = px.length > 4 * 400_000 ? 8 : 4; // subsample very large frames
    for (let i = 0; i < px.length; i += step) {
      if (px[i + 3] < 128) continue;
      hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
    }
  }
  const colors: number[] = [];
  for (let c = 0; c < 32768; c++) if (hist[c]) colors.push(c);
  type Box = { c: number[]; count: number };
  const ch = (c: number, k: number) => (k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31);
  const boxes: Box[] = [{ c: colors, count: colors.reduce((a, c) => a + hist[c], 0) }];
  while (boxes.length < max) {
    // split the box with the most pixels that can still be split, along its widest channel
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].c.length > 1 && boxes[i].count > best) { best = boxes[i].count; bi = i; }
    if (bi < 0) break;
    const b = boxes[bi];
    let k = 0, range = -1;
    for (let kk = 0; kk < 3; kk++) {
      let lo = 31, hi = 0;
      for (const c of b.c) { const v = ch(c, kk); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > range) { range = hi - lo; k = kk; }
    }
    b.c.sort((x, y) => ch(x, k) - ch(y, k));
    let acc = 0, cut = 1;
    for (let i = 0; i < b.c.length - 1; i++) { acc += hist[b.c[i]]; if (acc >= b.count / 2) { cut = i + 1; break; } cut = i + 1; }
    const a = b.c.slice(0, cut), z = b.c.slice(cut);
    boxes.splice(bi, 1, { c: a, count: a.reduce((s, c) => s + hist[c], 0) }, { c: z, count: z.reduce((s, c) => s + hist[c], 0) });
  }
  const pal = new Uint8Array(max * 3);
  boxes.forEach((b, i) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const c of b.c) { const w = hist[c]; r += (c >> 10) * w; g += ((c >> 5) & 31) * w; bl += (c & 31) * w; n += w; }
    n = Math.max(1, n);
    pal[i * 3] = Math.round(((r / n) * 255) / 31);
    pal[i * 3 + 1] = Math.round(((g / n) * 255) / 31);
    pal[i * 3 + 2] = Math.round(((bl / n) * 255) / 31);
  });
  return pal.slice(0, Math.max(1, boxes.length) * 3);
}

/** LZW-compresses indexed pixels into GIF data sub-blocks (min code size 8). */
export function lzw(indexes: Uint8Array, out: Bytes, minCode = 8) {
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  const table = new Int16Array(1 << 20).fill(-1);
  const used: number[] = [];
  let acc = 0, bits = 0;
  const block: number[] = [];
  const flushBlock = () => { if (block.length) { out.byte(block.length); out.bytes(block); block.length = 0; } };
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) { block.push(acc & 255); acc >>>= 8; bits -= 8; if (block.length === 255) flushBlock(); }
  };
  out.byte(minCode);
  emit(clear);
  if (!indexes.length) { emit(eoi); }
  else {
    let prefix = indexes[0];
    for (let i = 1; i < indexes.length; i++) {
      const c = indexes[i];
      const key = (prefix << 8) | c;
      const code = table[key];
      if (code >= 0) { prefix = code; continue; }
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        for (const k of used) table[k] = -1;
        used.length = 0;
        size = minCode + 1;
        next = eoi + 1;
      } else {
        if (next >= 1 << size) size++;
        table[key] = next++;
        used.push(key);
      }
      prefix = c;
    }
    emit(prefix);
    emit(eoi);
  }
  if (bits > 0) { block.push(acc & 255); if (block.length === 255) flushBlock(); }
  flushBlock();
  out.byte(0);
}

interface Pending { x: number; y: number; w: number; h: number; px: Uint8Array; delay: number; transparent: boolean }

export class GifEncoder {
  private out = new Bytes();
  private palette: Uint8Array | null = null;
  private lookup = new Int16Array(32768).fill(-1);
  private prev: Uint8Array | null = null;
  private pending: Pending | null = null;
  frames = 0;

  constructor(readonly width: number, readonly height: number) {}

  /** Builds the palette from sample frames; call once before the first frame (else frame 1 is used). */
  setPalette(samples: RGBA[]) {
    const p = medianCut(samples, 255);
    this.palette = new Uint8Array(256 * 3);
    this.palette.set(p);
    this.lookup.fill(-1);
  }

  private nearest(c15: number): number {
    const hit = this.lookup[c15];
    if (hit >= 0) return hit;
    const r = ((c15 >> 10) * 255) / 31, g = (((c15 >> 5) & 31) * 255) / 31, b = ((c15 & 31) * 255) / 31;
    const p = this.palette!;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 255; i++) {
      const dr = p[i * 3] - r, dg = p[i * 3 + 1] - g, db = p[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = i; }
    }
    this.lookup[c15] = best;
    return best;
  }

  private header() {
    const o = this.out;
    o.str("GIF89a");
    o.u16(this.width);
    o.u16(this.height);
    o.byte(0xf7); // global colour table, 8 bits, 256 entries
    o.byte(0);
    o.byte(0);
    o.bytes(this.palette!);
    // loop forever
    o.byte(0x21); o.byte(0xff); o.byte(11); o.str("NETSCAPE2.0"); o.byte(3); o.byte(1); o.u16(0); o.byte(0);
  }

  /** Adds a frame shown for delayMs. rgba must be width × height × 4. */
  addFrame(rgba: RGBA, delayMs: number) {
    const { width: W, height: H } = this;
    if (rgba.length !== W * H * 4) throw new Error("frame size mismatch");
    if (!this.palette) this.setPalette([rgba]);
    if (this.frames === 0 && this.out.n === 0) this.header();
    const idx = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = this.nearest(((rgba[j] >> 3) << 10) | ((rgba[j + 1] >> 3) << 5) | (rgba[j + 2] >> 3));
    const prev = this.prev;
    this.frames++;
    if (!prev) {
      this.pending = { x: 0, y: 0, w: W, h: H, px: idx, delay: delayMs, transparent: false };
      this.prev = idx;
      return;
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (idx[row + x] !== prev[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) { this.pending!.delay += delayMs; return; } // identical: show the last frame longer
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y + y0) * W + x + x0;
        px[y * w + x] = idx[k] === prev[k] ? TRANSPARENT : idx[k];
      }
    }
    this.flush();
    this.pending = { x: x0, y: y0, w, h, px, delay: delayMs, transparent: true };
    this.prev = idx;
  }

  private flush() {
    const p = this.pending;
    if (!p) return;
    const o = this.out;
    const cs = Math.max(2, Math.min(65535, Math.round(p.delay / 10)));
    o.byte(0x21); o.byte(0xf9); o.byte(4);
    o.byte((1 << 2) | (p.transparent ? 1 : 0)); // disposal 1: keep; transparency flag
    o.u16(cs);
    o.byte(TRANSPARENT);
    o.byte(0);
    o.byte(0x2c); o.u16(p.x); o.u16(p.y); o.u16(p.w); o.u16(p.h); o.byte(0);
    lzw(p.px, o);
    this.pending = null;
  }

  finish(): Uint8Array {
    if (!this.palette) throw new Error("no frames");
    this.flush();
    this.out.byte(0x3b);
    return this.out.out();
  }
}

/**
 * A minimal GIF decoder for tests: returns the frame count, size and the first frame's indexes, so
 * the encoder can be checked round-trip without a browser.
 */
export function decodeGif(data: Uint8Array): { width: number; height: number; frames: { x: number; y: number; w: number; h: number; delay: number; px: Uint8Array }[]; palette: Uint8Array } {
  let p = 0;
  const u8 = () => data[p++];
  const u16 = () => data[p++] | (data[p++] << 8);
  const sig = String.fromCharCode(...data.slice(0, 6));
  if (sig !== "GIF89a") throw new Error("not a GIF89a");
  p = 6;
  const width = u16(), height = u16();
  const packed = u8(); u8(); u8();
  const gctSize = packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0;
  const palette = data.slice(p, p + gctSize);
  p += gctSize;
  const frames: { x: number; y: number; w: number; h: number; delay: number; px: Uint8Array }[] = [];
  let delay = 0;
  for (;;) {
    const b = u8();
    if (b === 0x3b || b === undefined) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) { u8(); u8(); delay = u16() * 10; u8(); u8(); }
      else { for (let n = u8(); n; n = u8()) p += n; }
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad block 0x${b.toString(16)} at ${p - 1}`);
    const x = u16(), y = u16(), w = u16(), h = u16();
    u8();
    const min = u8();
    const sub: number[] = [];
    for (let n = u8(); n; n = u8()) { for (let i = 0; i < n; i++) sub.push(data[p + i]); p += n; }
    frames.push({ x, y, w, h, delay, px: unlzw(Uint8Array.from(sub), min, w * h) });
  }
  return { width, height, frames, palette };
}

function unlzw(d: Uint8Array, min: number, n: number): Uint8Array {
  const clear = 1 << min, eoi = clear + 1;
  let size = min + 1, next = eoi + 1;
  const dict: number[][] = [];
  const reset = () => { dict.length = 0; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = min + 1; next = eoi + 1; };
  reset();
  const out: number[] = [];
  let acc = 0, bits = 0, pos = 0, prev: number[] | null = null;
  for (;;) {
    while (bits < size && pos < d.length) { acc |= d[pos++] << bits; bits += 8; }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size; bits -= size;
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < next && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("bad code");
    out.push(...entry);
    if (prev && next < 4096) { dict[next++] = [...prev, entry[0]]; if (next === 1 << size && size < 12) size++; }
    prev = entry;
  }
  return Uint8Array.from(out.slice(0, n));
}
