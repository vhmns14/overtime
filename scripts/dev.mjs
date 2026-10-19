// npm run dev: the Worker (wrangler dev, previews + LLM proxy) on :8787 and Vite (HMR) on :5173.
// Vite proxies /api and /p to the Worker. Open http://localhost:5173
import { spawn } from "node:child_process";
const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
const worker = run("npx", ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1", "--local"]);
const ui = run("npx", ["vite", "--port", "5173"]);
const stop = () => { worker.kill(); ui.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
worker.on("exit", (c) => { if (c) console.error(`wrangler exited (${c}); the UI still runs, previews fall back to in-browser rendering.`); });
