import { describe, expect, it } from "vitest";
import { runChecks, resolveRef, contrast, parseColor, basicSyntax, defaultSyntax, readCss } from "../src/engine/checks";
import { DEMO_FILES } from "../src/demo/demo-llm";

const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>T</title>${head}</head><body>${body}</body></html>`;
const status = (files: Record<string, string>, id: string) => runChecks(files).results.find((r) => r.id === id)!;

describe("checks", () => {
  it("the fixed demo site passes everything", () => {
    const r = runChecks({ "index.html": DEMO_FILES.indexV2, "css/style.css": DEMO_FILES.styleCss, "js/main.js": DEMO_FILES.mainJs, "img/senja-cup.svg": DEMO_FILES.cupSvg });
    expect(r.results.filter((x) => x.status !== "pass")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("the first demo build fails exactly links + alt", () => {
    const r = runChecks({ "index.html": DEMO_FILES.indexV1, "css/style.css": DEMO_FILES.styleCss, "js/main.js": DEMO_FILES.mainJs, "img/senja-cup.svg": DEMO_FILES.cupSvg });
    expect(r.results.filter((x) => x.status === "fail").map((x) => x.id).sort()).toEqual(["alt", "links"]);
    expect(r.results.find((x) => x.id === "links")!.details[0]).toContain('"css/styles.css" not found');
  });

  it("flags HTML parse errors", () => {
    expect(status({ "index.html": "<html><body><p>hi</p></body></html>" }, "html").details.join()).toMatch(/missing-doctype/);
    expect(status({ "index.html": page("<div><p>x</div></span>") }, "html").status).toBe("pass"); // tree-construction quirks are not tokenizer errors
    expect(status({ "index.html": page('<a href="x>broken') }, "html").status).toBe("fail");
  });

  it("finds broken links, assets, anchors and CSS urls", () => {
    const files = {
      "index.html": page('<a href="about.html">a</a><a href="#nope">n</a><img src="img/x.png" alt="x"><a href="https://example.com">ext</a><a href="docs/">d</a>', '<link rel="stylesheet" href="./css/a.css">'),
      "css/a.css": "body{background:url(../img/bg.svg)} .x{background:url('data:image/png;base64,AA')}",
      "docs/index.html": page("ok"),
    };
    const d = status(files, "links").details.join("\n");
    expect(d).toContain('"about.html" not found');
    expect(d).toContain("#nope");
    expect(d).toContain('"img/x.png" not found');
    expect(d).toContain("url(../img/bg.svg) not found");
    expect(d).not.toContain("example.com");
    expect(d).not.toContain("docs/");
    expect(d).not.toContain("data:");
  });

  it("resolves relative refs safely", () => {
    expect(resolveRef("a/b/index.html", "../c.css")).toBe("a/c.css");
    expect(resolveRef("index.html", "../../etc/passwd")).toBeNull();
    expect(resolveRef("index.html", "/x/")).toBe("x/index.html");
    expect(resolveRef("index.html", "y.html?v=1#top")).toBe("y.html");
  });

  it("a11y: alt, labels, names", () => {
    const files = { "index.html": page('<img src="a.svg"><img src="a.svg" alt=""><input name="email"><label for="n">N</label><input id="n"><input type="hidden" name="h"><input aria-label="q"><button></button><button aria-label="x"></button><a href="#"></a>'), "a.svg": "<svg/>" };
    expect(status(files, "alt").details).toHaveLength(1);
    expect(status(files, "labels").details).toEqual(['index.html: <input name="email"> has no label']);
    expect(status(files, "names").details).toHaveLength(2);
  });

  it("contrast uses custom properties and flags low ratios", () => {
    expect(contrast(parseColor("#fff")!, parseColor("#000")!)).toBeCloseTo(21, 0);
    const bad = { "index.html": page("x", "<style>:root{--fg:#999}.card{color:var(--fg);background:#aaa}</style>") };
    expect(status(bad, "contrast").details[0]).toMatch(/\.card: text contrast/);
    const good = { "index.html": page("x", "<style>body{color:#222;background:#fff}</style>") };
    expect(status(good, "contrast").status).toBe("pass");
    expect(readCss("@media (max-width:1px){.a{color:red}}")[0].selector).toBe(".a");
  });

  it("JS syntax: catches real errors in files and inline scripts, supports ES syntax", () => {
    expect(defaultSyntax("const a = ;")).toBeTruthy();
    expect(defaultSyntax("import x from './x.js';\nexport const y = 1; export default y;")).toBeNull();
    const files = { "index.html": page("<script>if (x {</script>"), "app.js": "function(){" };
    expect(status(files, "js").details).toHaveLength(2);
    expect(basicSyntax("a(){ 'x' }")).toBeNull();
    expect(basicSyntax("a({)")).toMatch(/unexpected/);
    expect(basicSyntax("'abc")).toMatch(/unterminated/);
  });

  it("CSS syntax and size budget", () => {
    expect(status({ "index.html": page("x"), "s.css": "a{color:red" }, "css").status).toBe("fail");
    const big = runChecks({ "index.html": page("x".repeat(3000)) }, { sizeBudgetBytes: 1000 });
    expect(big.results.find((r) => r.id === "size")!.status).toBe("fail");
  });

  it("missing index.html is a failure; meta basics are warnings", () => {
    expect(status({ "about.html": "<!doctype html><html><body>x</body></html>" }, "links").details[0]).toMatch(/index.html is missing/);
    const r = runChecks({ "index.html": "<!doctype html><html><body>x</body></html>" });
    expect(r.results.find((x) => x.id === "meta")!.status).toBe("warn");
  });
});
