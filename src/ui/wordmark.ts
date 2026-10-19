// The pixel wordmark: a tiny hand-drawn bitmap font rendered as crisp SVG rects (works offline,
// no webfont). Glyphs are 9 rows tall; "#" is an on pixel.
const G: Record<string, string[]> = {
  O: [".#####.", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", ".#####."],
  v: [".......", ".......", ".......", "##...##", "##...##", "##...##", ".##.##.", ".##.##.", "..###.."],
  e: [".......", ".......", ".......", ".#####.", "##...##", "#######", "##.....", "##...##", ".#####."],
  r: ["......", "......", "......", "##.###", "###..#", "##....", "##....", "##....", "##...."],
  t: ["......", ".##...", ".##...", "#####.", ".##...", ".##...", ".##...", ".##..#", "..###."],
  i: ["##", "..", "..", "##", "##", "##", "##", "##", "##"],
  m: ["..........", "..........", "..........", "#########.", "##..##..##", "##..##..##", "##..##..##", "##..##..##", "##..##..##"],
};

export function wordmarkSVG(text = "Overtime", color = "#141210"): string {
  let x = 0;
  const rects: string[] = [];
  for (const ch of text) {
    const g = G[ch];
    if (!g) { x += 4; continue; }
    g.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) if (row[i] === "#") rects.push(`<rect x="${x + i}" y="${y}" width="1.02" height="1.02"/>`);
    });
    x += g[0].length + 1;
  }
  const w = x - 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 9" width="${w * 4}" height="36" shape-rendering="crispEdges" fill="${color}" aria-hidden="true">${rects.join("")}</svg>`;
}
