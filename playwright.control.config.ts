import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Remote-control e2e on its own port (other worktrees may hold :8787). Run `npm run build` first, then
//   npx wrangler dev --port 8931 --ip 127.0.0.1 --local --var TELEGRAM_API_BASE:http://127.0.0.1:8932
// (the spec starts a mock Telegram API on :8932; nothing reaches the real Telegram).
export default defineConfig({
  ...base,
  testMatch: /control\.spec\.ts$/,
  workers: 1, // one mock Telegram API on :8932
  use: { ...base.use, baseURL: "http://127.0.0.1:8931" },
  webServer: {
    command: "npx wrangler dev --port 8931 --ip 127.0.0.1 --local --inspector-port 9331 --var TELEGRAM_API_BASE:http://127.0.0.1:8932",
    url: "http://127.0.0.1:8931/api/health",
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
