import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { viteSingleFile } from "vite-plugin-singlefile";
import type { Plugin } from "vite";

/** Serves the Hermes plugin from the app itself, so the Connect screen's curl lines point at your own deployment. */
function hermesPluginFiles(): Plugin {
  const files = ["plugin.yaml", "__init__.py", "overtime_control.py", "install.sh"];
  const read = (f: string) => readFileSync(resolve(__dirname, "integrations/hermes-overtime", f), "utf8");
  // the installer checks every file it downloads against these (sha256sum format)
  const sums = () => files.filter((f) => f !== "install.sh").map((f) => `${createHash("sha256").update(read(f)).digest("hex")}  ${f}`).join("\n") + "\n";
  return {
    name: "hermes-overtime-files",
    generateBundle() {
      for (const f of files) this.emitFile({ type: "asset", fileName: `hermes-overtime/${f}`, source: read(f) });
      this.emitFile({ type: "asset", fileName: "hermes-overtime/SHA256SUMS", source: sums() });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/hermes-overtime\/(plugin\.yaml|__init__\.py|overtime_control\.py|install\.sh|SHA256SUMS)$/);
        if (!m) return next();
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(m[1] === "SHA256SUMS" ? sums() : read(m[1]));
      });
    },
  };
}

const PREVIEW = process.env.PREVIEW === "1";

export default defineConfig({
  define: { __PREVIEW__: JSON.stringify(PREVIEW) },
  build: PREVIEW
    ? {
        outDir: "dist-preview",
        assetsInlineLimit: 100_000_000,
        cssCodeSplit: false,
        modulePreload: false,
        rollupOptions: { input: resolve(__dirname, "index.html"), output: { format: "iife", inlineDynamicImports: true } },
      }
    : { outDir: "dist", assetsInlineLimit: 4096 },
  plugins: PREVIEW ? [viteSingleFile({ removeViteModuleLoader: true })] : [hermesPluginFiles()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787", "/p/": "http://127.0.0.1:8787" } },
});
