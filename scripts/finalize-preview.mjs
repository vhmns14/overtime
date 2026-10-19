// Turns dist-preview/index.html into preview.html: ONE inline classic <script> (no ES modules,
// no import/export, never the word "module"), everything inlined, no network, strict CSP.
// It runs the demo fully offline inside a sandboxed iframe (allow-scripts only, no storage).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

let html = readFileSync("dist-preview/index.html", "utf8");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
html = html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
// drop the woff fallbacks (every browser that runs this has woff2)
html = html.replace(/,\s*url\(data:font\/woff;base64,[A-Za-z0-9+/=]+\)\s*format\(["']woff["']\)/g, "");
// vite's preload helper mentions the forbidden word; it is dead code in a single inlined chunk
html = html.replace(/[A-Za-z_$][\w$]*\.supports\("modulepreload"\)\?"modulepreload":"preload"/g, '"preload"');
html = html.replace(/new URL\("[^"]+",document\.baseURI\)\.href/g, '""');
// classic script, run after the DOM is parsed
const re = /<script type="module" crossorigin>([\s\S]*?)<\/script>/;
const m = html.match(re);
if (!m) throw new Error("no inline script found");
// script text must not contain "<script" / "</script" / "<!--" (the demo site lives in JS strings):
// \x3c is the same character inside JS strings, templates and regexes
const js = m[1].replace(/<(\/?)(script)/gi, "\\x3c$1$2").replace(/<!--/g, "\\x3c!--");
html = html.replace(m[0], "");
html = html.replace("</body>", () => `<script>${js}</script>\n</body>`);
if (/type="module"|import\.meta/.test(html)) throw new Error("preview still uses ES features that need a module script");
const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((x) => x[0]);
if (scripts.length !== 1 || scripts[0] !== "<script>") throw new Error(`need exactly one classic inline <script>, found: ${scripts.join(" ")}`);
const word = html.match(/.{0,50}module.{0,50}/i);
if (word) throw new Error(`preview contains the word: ${word[0]}`);
const stmt = html.match(/(?:^|[;{}\n]\s*)(?:import\s*[\w{*("'`]|export\s+(?:default|const|let|var|function|class|\{|\*))/);
if (stmt) throw new Error(`preview contains an import/export statement near: ${html.slice(Math.max(0, stmt.index - 40), stmt.index + 60)}`);
const markup = html.replace(/<script>[\s\S]*<\/script>/, "");
const external = [...markup.matchAll(/\s(?:src|href)="(?!#|data:|https:\/\/github\.com\/)([^"]+)"/g)].map((x) => x[1]);
if (external.length) throw new Error(`preview has external refs: ${external.slice(0, 5).join(", ")}`);
if (/\bhark\b/i.test(html)) throw new Error("preview contains forbidden branding");
writeFileSync("preview.html", html);
const sha = createHash("sha256").update(html).digest("hex");
writeFileSync("preview.html.sha256", `${sha}  preview.html\n`);
console.log(`preview.html ${(html.length / 1024).toFixed(0)} KB sha256 ${sha}`);
