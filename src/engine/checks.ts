// The Reviewer's real, deterministic checks over the generated static site.
// Runs in the browser and in Node (vitest): parse5 for HTML, a small CSS reader for contrast,
// the JS engine's own parser for syntax, and plain path resolution for links and assets.

import { parse } from "parse5";
import type { CheckReport, CheckResult } from "./types";

type Node = {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
  value?: string;
};

const MODULE_WORD = ["mod", "ule"].join(""); // kept out of the source text on purpose (single-file preview rule)

function attr(n: Node, name: string): string | undefined {
  return n.attrs?.find((a) => a.name === name)?.value;
}

function walk(n: Node, fn: (n: Node) => void) {
  fn(n);
  n.childNodes?.forEach((c) => walk(c, fn));
  if (n.content) walk(n.content, fn);
}

function textOf(n: Node): string {
  let s = "";
  walk(n, (c) => {
    if (c.nodeName === "#text") s += c.value ?? "";
    if (c.tagName === "img" && attr(c, "alt")) s += attr(c, "alt");
  });
  return s.trim();
}

function isExternal(u: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u) || u.trim() === "";
}

function dirOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
}

/** Resolves a relative URL from a file inside the project to a project path, or null if it escapes. */
export function resolveRef(from: string, ref: string): string | null {
  let r = ref.split("#")[0].split("?")[0];
  if (!r) return null;
  try {
    r = decodeURIComponent(r);
  } catch {
    /* keep raw */
  }
  const base = r.startsWith("/") ? [] : dirOf(from).split("/").filter(Boolean);
  for (const part of r.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else base.push(part);
  }
  let out = base.join("/");
  if (r.endsWith("/") || out === "") out = out ? out + "/index.html" : "index.html";
  return out;
}

// ---------- colour + contrast ----------
const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000", red: "#ff0000", gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", orange: "#ffa500", yellow: "#ffff00", brown: "#a52a2a", beige: "#f5f5dc", ivory: "#fffff0", tan: "#d2b48c", maroon: "#800000", green: "#008000", blue: "#0000ff" };

export function parseColor(v: string): [number, number, number] | null {
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]);
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length < 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

function lum([r, g, b]: [number, number, number]) {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: [number, number, number], b: [number, number, number]) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

interface Rule {
  selector: string;
  decls: Record<string, string>;
}

export function readCss(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const selector = m[1].trim().replace(/^@[^{]*$/, "").trim();
    const decls: Record<string, string> = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    out.push({ selector, decls });
  }
  return out;
}

function firstColorToken(v: string, vars: Record<string, string>, depth = 0): [number, number, number] | null {
  if (depth > 5) return null;
  const withVars = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, name, fb) => vars[name] ?? fb ?? "");
  if (/gradient|url\(/.test(withVars)) return null; // cannot judge reliably
  const tokens = withVars.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/g) ?? [];
  for (const t of tokens) {
    const c = parseColor(t);
    if (c) return c;
  }
  return null;
}

const hex = (c: [number, number, number]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");

/** A concrete fix a model can apply: darker/lighter background for the same text colour, or black/white text. */
function contrastHint(fg: [number, number, number], bg: [number, number, number]): string {
  const lum = (c: [number, number, number]) => contrast(c, [0, 0, 0]);
  const fgLight = lum(fg) > lum(bg);
  let b: [number, number, number] = [...bg];
  for (let i = 0; i < 40 && contrast(fg, b) < 4.6; i++) b = b.map((x) => (fgLight ? x * 0.9 : x + (255 - x) * 0.15)) as [number, number, number];
  const textAlt: [number, number, number] = contrast([17, 17, 17], bg) >= contrast([255, 255, 255], bg) ? [17, 17, 17] : [255, 255, 255];
  const parts = [];
  if (contrast(fg, b) >= 4.5) parts.push(`e.g. background ${hex(b)} (${contrast(fg, b).toFixed(1)}:1)`);
  if (contrast(textAlt, bg) >= 4.5) parts.push(`or color ${hex(textAlt)} (${contrast(textAlt, bg).toFixed(1)}:1)`);
  return `text ${hex(fg)} on ${hex(bg)}${parts.length ? `: ${parts.join(" ")}` : ""}`;
}

function contrastIssues(cssTexts: { file: string; text: string }[]): string[] {
  const rules = cssTexts.flatMap((c) => readCss(c.text).map((r) => ({ ...r, file: c.file })));
  const vars: Record<string, string> = {};
  for (const r of rules) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--")) vars[k] = v;
  const issues: string[] = [];
  let pageFg: [number, number, number] | null = null;
  let pageBg: [number, number, number] | null = null;
  for (const r of rules) {
    const sel = r.selector;
    const fgRaw = r.decls["color"];
    const bgRaw = r.decls["background-color"] ?? r.decls["background"];
    const fg = fgRaw ? firstColorToken(fgRaw, vars) : null;
    const bg = bgRaw ? firstColorToken(bgRaw, vars) : null;
    if (/^(html|body|:root)(\s*,\s*(html|body|:root))*$/.test(sel)) {
      if (fg) pageFg = fg;
      if (bg) pageBg = bg;
    }
    if (fg && bg) {
      const c = contrast(fg, bg);
      if (c < 4.5) issues.push(`${sel}: text contrast ${c.toFixed(2)}:1 (needs 4.5:1; rule in ${r.file}; ${contrastHint(fg, bg)})`);
    }
  }
  if (pageFg && pageBg) {
    const c = contrast(pageFg, pageBg);
    if (c < 4.5 && !issues.some((i) => /^(html|body)/.test(i))) issues.push(`body: text contrast ${c.toFixed(2)}:1 (needs 4.5:1)`);
  }
  return issues;
}

// ---------- JS syntax ----------
export type SyntaxChecker = (code: string) => string | null;

/** Strips static import/export so ES-style scripts can be syntax-checked as a function body. */
function stripEsm(code: string) {
  return code
    .replace(/(^|[;}\n])\s*import\s+(?:[\w*{}\s,]+from\s*)?["'][^"']+["'];?/g, "$1")
    .replace(/(^|[;}\n])\s*export\s+default\s+/g, "$1")
    .replace(/(^|[;}\n])\s*export\s+(?=(const|let|var|function|class|async)\b)/g, "$1")
    .replace(/(^|[;}\n])\s*export\s*\{[^}]*\}(?:\s*from\s*["'][^"']+["'])?;?/g, "$1");
}

/** Fallback when eval is blocked by CSP: balanced brackets, strings and comments. */
export function basicSyntax(code: string): string | null {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") line++;
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      line++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const e = code.indexOf("*/", i + 2);
      if (e < 0) return `unterminated comment (line ${line})`;
      line += code.slice(i, e).split("\n").length - 1;
      i = e + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        if (code[j] === "\n" && c !== "`") return `unterminated string (line ${line})`;
        j++;
      }
      if (j >= code.length) return `unterminated string (line ${line})`;
      line += code.slice(i, j).split("\n").length - 1;
      i = j;
      continue;
    }
    if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c)) {
      if (stack.pop() !== pairs[c]) return `unexpected "${c}" (line ${line})`;
    }
  }
  return stack.length ? `missing closing bracket for "${stack[stack.length - 1]}"` : null;
}

export const defaultSyntax: SyntaxChecker = (code) => {
  const body = stripEsm(code);
  try {
    // Compiles only, never calls: a syntax check without running untrusted code.
    new Function(body);
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) return e.message;
    return basicSyntax(body); // EvalError under a strict CSP
  }
};

// ---------- main ----------
export interface CheckOptions {
  sizeBudgetBytes?: number;
  syntax?: SyntaxChecker;
}

const IGNORED_PARSE_ERRORS = new Set(["non-void-html-element-start-tag-with-trailing-solidus"]);

export function runChecks(files: Record<string, string>, opts: CheckOptions = {}): CheckReport {
  const budget = opts.sizeBudgetBytes ?? 250_000;
  const syntax = opts.syntax ?? defaultSyntax;
  const htmlFiles = Object.keys(files).filter((f) => /\.html?$/i.test(f)).sort();
  const results: CheckResult[] = [];
  const parseErr: string[] = [];
  const meta: string[] = [];
  const links: string[] = [];
  const alt: string[] = [];
  const labels: string[] = [];
  const names: string[] = [];
  const jsErr: string[] = [];
  const cssErr: string[] = [];
  const inlineCss: { file: string; text: string }[] = [];

  if (!files["index.html"]) links.push("index.html is missing (the preview needs an entry page)");

  for (const f of htmlFiles) {
    const src = files[f];
    const doc = parse(src, {
      sourceCodeLocationInfo: true,
      onParseError: (err: { code: string; startLine: number }) => {
        if (!IGNORED_PARSE_ERRORS.has(err.code)) parseErr.push(`${f}:${err.startLine} ${err.code}`);
      },
    } as never) as unknown as Node;
    let hasLang = false, hasTitle = false, hasViewport = false;
    const ids = new Set<string>();
    const labelled = new Set<string>();
    walk(doc, (n) => {
      const id = n.tagName ? attr(n, "id") : undefined;
      if (id) ids.add(id);
      if (n.tagName === "label" && attr(n, "for")) labelled.add(attr(n, "for")!);
    });
    walk(doc, (n) => {
      const t = n.tagName;
      if (!t) return;
      if (t === "html" && attr(n, "lang")) hasLang = true;
      if (t === "title" && textOf(n)) hasTitle = true;
      if (t === "meta" && attr(n, "name") === "viewport") hasViewport = true;
      const refs: string[] = [];
      if (["a", "link", "area"].includes(t) && attr(n, "href") !== undefined) refs.push(attr(n, "href")!);
      if (["img", "script", "source", "iframe", "audio", "video", "track"].includes(t) && attr(n, "src")) refs.push(attr(n, "src")!);
      for (const r of refs) {
        if (r.startsWith("#") && r.length > 1 && t === "a") {
          if (!ids.has(r.slice(1))) links.push(`${f}: in-page link ${r} has no matching id`);
          continue;
        }
        if (isExternal(r)) continue;
        const target = resolveRef(f, r);
        if (!target) links.push(`${f}: "${r}" points outside the project`);
        else if (!(target in files)) links.push(`${f}: "${r}" not found (resolved to ${target})`);
      }
      if (t === "img" && attr(n, "alt") === undefined && attr(n, "role") !== "presentation") alt.push(`${f}: <img src="${attr(n, "src") ?? "?"}"> has no alt text`);
      if (["input", "select", "textarea"].includes(t)) {
        const type = (attr(n, "type") ?? "text").toLowerCase();
        if (!["hidden", "submit", "button", "reset", "image"].includes(type)) {
          const nid = attr(n, "id");
          const ok = attr(n, "aria-label") || attr(n, "aria-labelledby") || attr(n, "title") || (nid && labelled.has(nid));
          if (!ok) labels.push(`${f}: <${t}${attr(n, "name") ? ` name="${attr(n, "name")}"` : ""}> has no label`);
        }
      }
      if ((t === "button" || (t === "a" && attr(n, "href") !== undefined)) && !textOf(n) && !attr(n, "aria-label") && !attr(n, "title"))
        names.push(`${f}: <${t}> has no accessible name`);
      if (t === "style") inlineCss.push({ file: `${f} <style>`, text: textOf(n) });
      if (t === "script" && !attr(n, "src")) {
        const type = (attr(n, "type") ?? "").toLowerCase();
        if (!type || type === MODULE_WORD || /javascript/.test(type)) {
          const err = syntax(textOf(n));
          if (err) jsErr.push(`${f} inline script: ${err}`);
        }
      }
    });
    if (!hasLang) meta.push(`${f}: <html> has no lang attribute`);
    if (!hasTitle) meta.push(`${f}: missing <title>`);
    if (!hasViewport) meta.push(`${f}: missing viewport meta`);
  }

  for (const [f, src] of Object.entries(files)) {
    if (/\.m?js$/i.test(f)) {
      const err = syntax(src);
      if (err) jsErr.push(`${f}: ${err}`);
    }
    if (/\.css$/i.test(f)) {
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\/\*/.test(noComments)) cssErr.push(`${f}: unterminated comment`);
      const open = (noComments.match(/\{/g) ?? []).length;
      const close = (noComments.match(/\}/g) ?? []).length;
      if (open !== close) cssErr.push(`${f}: unbalanced braces (${open} "{" vs ${close} "}")`);
      for (const m of noComments.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const r = m[1];
        if (isExternal(r) || r.startsWith("data:")) continue;
        const target = resolveRef(f, r);
        if (!target || !(target in files)) links.push(`${f}: url(${r}) not found`);
      }
    }
  }

  const cssTexts = [...Object.entries(files).filter(([f]) => /\.css$/i.test(f)).map(([file, text]) => ({ file, text })), ...inlineCss];
  const contrastErr = contrastIssues(cssTexts);
  const totalBytes = Object.values(files).reduce((n, s) => n + new TextEncoder().encode(s).length, 0);
  const size: string[] = totalBytes > budget ? [`total ${(totalBytes / 1024).toFixed(1)} KB exceeds the ${(budget / 1024).toFixed(0)} KB budget`] : [];

  const push = (id: string, label: string, details: string[], level: "fail" | "warn" = "fail") =>
    results.push({ id, label, status: details.length ? level : "pass", details });
  push("html", "HTML parses cleanly", parseErr.slice(0, 12));
  push("links", "Internal links and assets resolve", links);
  push("alt", "Images have alt text", alt);
  push("labels", "Form fields have labels", labels);
  push("names", "Buttons and links have names", names);
  push("contrast", "Text contrast ≥ 4.5:1", contrastErr);
  push("js", "JavaScript syntax", jsErr);
  push("css", "CSS syntax", cssErr);
  push("size", `Size budget (${(totalBytes / 1024).toFixed(1)} KB)`, size);
  push("meta", "Document basics (lang, title, viewport)", meta, "warn");

  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return { ok: failures === 0, failures, warnings, results, totalBytes };
}

export function summarizeReport(r: CheckReport): string {
  if (r.ok) return `all ${r.results.length} checks pass${r.warnings ? ` (${r.warnings} warning${r.warnings > 1 ? "s" : ""})` : ""}`;
  return r.results
    .filter((x) => x.status === "fail")
    .map((x) => `${x.label}: ${x.details.slice(0, 3).join("; ")}`)
    .join(" | ");
}
