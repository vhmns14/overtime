import { defineConfig, devices } from "@playwright/test";

// Local browsers live in the workspace; the headless shell needs a few extra shared libs on this box.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/workspace/work/.pw-browsers";
process.env.NO_PROXY = ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
if (process.env.PW_EXTRA_LIBS !== "0") process.env.LD_LIBRARY_PATH = ["/workspace/work/.pw-libs", process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
// OT_PORT (+ OT_INSPECTOR_PORT) let several checkouts run their e2e side by side (default 8787)
const PORT = Number(process.env.OT_PORT ?? 8787);
const executablePath = process.env.PW_CHROMIUM ?? (process.env.CI ? undefined : "/workspace/work/.pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell");

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off", screenshot: "off", launchOptions: { executablePath } },
  webServer: {
    // run `npm run build` first: wrangler dev serves dist/ + the Worker (previews, proxy) locally
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --local${process.env.OT_INSPECTOR_PORT ? ` --inspector-port ${process.env.OT_INSPECTOR_PORT}` : ""}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 90_000,
  },
  projects: [
    { name: "mobile-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, launchOptions: { executablePath } } },
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } },
  ],
});
