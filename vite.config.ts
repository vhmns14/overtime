import { defineConfig } from "vite";
import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";

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
  plugins: PREVIEW ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787", "/p/": "http://127.0.0.1:8787" } },
});
