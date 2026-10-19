import { defineConfig } from "vitest/config";
export default defineConfig({
  define: { __PREVIEW__: "false" },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
