// A 3×5 pixel font for the scoreboard, the floor plates and other in-world labels, drawn with
// fillRect so it stays crisp at any zoom (no font files, no smoothing).

const G: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001111",
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111",
  F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", K: "101101110101101",
  L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  R: "110101110101101", S: "011100010001110", T: "111010010010010", U: "101101101101111", V: "101101101101010",
  W: "101101111111101", Y: "101101010010010", X: "101101010101101", Z: "111001010100111", J: "001001001101010", Q: "010101101110011", "+": "000010111010000", "-": "000000111000000",
  "·": "000000010000000", " ": "000000000000000", "✓": "000001001101010", "✗": "000101010101000", "?": "111001011000010",
};

/** width in font pixels of a string at scale 1 (3 px glyphs, 1 px spacing) */
export const textWidth = (s: string, scale = 1) => Math.max(0, s.length * 4 - 1) * scale;

/** draws text with its top-left at (x, y) in the current transform */
export function pixText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, scale = 1, color = "#fff") {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const g = G[ch] ?? G["?"];
    for (let i = 0; i < 15; i++) if (g[i] === "1") ctx.fillRect(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale);
    cx += 4 * scale;
  }
}
