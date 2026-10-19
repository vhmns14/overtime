import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  define: { __PREVIEW__: "false" },
  resolve: { alias: { "cloudflare:workers": resolve(__dirname, "tests/helpers/cloudflare-workers.ts") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
