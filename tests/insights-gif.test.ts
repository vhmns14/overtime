import { describe, expect, it } from "vitest";
import { GifEncoder, decodeGif, medianCut } from "../src/insights/gif";

function frame(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
  return px;
}

describe("GIF encoder", () => {
  it("writes a valid looping GIF89a that decodes back to the same pixels", () => {
    const W = 64, H = 40;
    const f1 = frame(W, H, (x, y) => [x * 4, y * 6, (x + y) % 2 ? 230 : 20]);
    const enc = new GifEncoder(W, H);
    enc.addFrame(f1, 100);
    const gif = enc.finish();
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect(gif.at(-1)).toBe(0x3b);
    expect(String.fromCharCode(...gif.slice(13 + 768 + 3, 13 + 768 + 14))).toBe("NETSCAPE2.0");
    const d = decodeGif(gif);
    expect([d.width, d.height, d.frames.length]).toEqual([W, H, 1]);
    const fr = d.frames[0];
    expect(fr.px.length).toBe(W * H);
    // every decoded pixel is close to its source colour (5-bit quantisation + palette)
    let worst = 0;
    for (let i = 0; i < W * H; i++) {
      const p = fr.px[i];
      const dr = Math.abs(d.palette[p * 3] - f1[i * 4]), dg = Math.abs(d.palette[p * 3 + 1] - f1[i * 4 + 1]), db = Math.abs(d.palette[p * 3 + 2] - f1[i * 4 + 2]);
      worst = Math.max(worst, dr, dg, db);
    }
    expect(worst).toBeLessThan(48);
  });

  it("crops later frames to what changed, with transparency, and merges identical frames", () => {
    const W = 80, H = 60;
    const bg = (x: number, y: number): [number, number, number] => [20 + (x % 8) * 10, 30, 40 + (y % 6) * 12];
    const enc = new GifEncoder(W, H);
    enc.addFrame(frame(W, H, bg), 100);
    enc.addFrame(frame(W, H, bg), 100); // identical: no new image, longer delay
    enc.addFrame(frame(W, H, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 9 ? [250, 120, 40] : bg(x, y))), 100);
    const d = decodeGif(enc.finish());
    expect(d.frames).toHaveLength(2);
    expect(d.frames[0].delay).toBe(200);
    expect(d.frames[1]).toMatchObject({ x: 10, y: 5, w: 10, h: 4 });
  });

  it("a long mostly-static clip stays small", () => {
    const W = 320, H = 200;
    const enc = new GifEncoder(W, H);
    for (let i = 0; i < 60; i++) enc.addFrame(frame(W, H, (x, y) => (Math.abs(x - 40 - i * 3) < 6 && Math.abs(y - 100) < 10 ? [232, 116, 47] : [((x >> 4) * 13) & 255, 24, ((y >> 4) * 17) & 255])), 100);
    const gif = enc.finish();
    expect(gif.length).toBeLessThan(120_000);
    expect(decodeGif(gif).frames.length).toBe(60);
  });

  it("LZW survives dictionary resets on noisy frames", () => {
    const W = 200, H = 150;
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    const f = frame(W, H, () => [rnd(), rnd(), rnd()]);
    const enc = new GifEncoder(W, H);
    enc.addFrame(f, 80);
    const d = decodeGif(enc.finish());
    expect(d.frames[0].px.length).toBe(W * H);
  });

  it("median cut returns at most the requested colours", () => {
    const p = medianCut([frame(32, 32, (x, y) => [x * 8, y * 8, 128])], 16);
    expect(p.length).toBeLessThanOrEqual(48);
    expect(p.length % 3).toBe(0);
  });
});
