# Overtime

**Give a task and watch a small team of AI agents build it in a pixel-art office. You approve the steps that matter.**

Overtime is an open-source web app. Five agents (PM, Research, Coder, Reviewer, Ops) take a task like *"Build a landing page for Kopi Senja"* and turn it into a real static site. You watch them walk to their desks and type, meet at the round table for handoffs, put tickets on the whiteboard and grab coffee when they're idle. When a decision matters, they stop and wait for you.

The first visit runs in **demo mode**, so no key is needed. The demo replays a recorded run through the real engine and the real checks. To run your own tasks on any OpenAI-compatible model, **bring your own key**.

![Overtime on desktop](docs/screenshot-desktop.png)

<p align="center"><img src="docs/screenshot-mobile-office.png" width="300" alt="Overtime on a phone: office on top, run sheet below"> <img src="docs/screenshot-mobile-approval.png" width="300" alt="Phone approval card with diff snippet"></p>

| Files with diffs between Coder iterations | Sandboxed preview served at `/p/<runId>/` |
|---|---|
| ![Files and diff](docs/screenshot-files.png) | ![Preview](docs/screenshot-preview.png) |

<details><summary>Approved mockup vs. the real app</summary>

![Desktop: mockup vs app](docs/compare-desktop.png)
![Mobile: mockup vs app](docs/compare-mobile.png)

</details>

---

## Features

- **A live office.** Characters walk a nav graph between desks, the whiteboard, the meeting table and the coffee machine. Monitors glow while an agent types, lamps flicker and rain runs down the window. Click any agent to see its current thought, recent log, the files it touched and what it has spent.
- **Real work, end to end.**
  - **PM** writes the ticket list, which shows up as stickies on the whiteboard.
  - **Research** writes `notes/brief.md`. It can read one reference URL you give it, fetched through the Worker and handled strictly as data.
  - **Coder** writes multi-file static sites (HTML, CSS, JS, SVG).
  - **Reviewer** runs real automated checks and sends fixes back to the Coder (2 rounds at most).
  - **Ops** publishes a preview and offers a ZIP. It can also push to your GitHub repo.
- **Reviewer checks are deterministic, not vibes:**
  - HTML parse errors (parse5)
  - Broken internal links and assets, including CSS `url()` refs and in-page anchors
  - `alt` text, form labels, accessible names for buttons and links
  - Text contrast of 4.5:1 or better (reads CSS custom properties)
  - JS syntax, CSS syntax and a total size budget
  - Document basics (`lang`, `<title>`, viewport) as warnings
- **Approval gates** you can switch on or off: plan approval, when the Reviewer finds failures, and before deploy/push. Each gate offers Approve, Reject or Comment. Reject with a comment sends the feedback back to that agent, who redoes the step.
- **A side panel that follows the run:**
  - Step tracker: Plan, Research, Code %, Review, Deploy
  - Timestamped mono activity log
  - Approval card
  - Token cost meter in $ and tokens, with a per-agent breakdown on click
- **Phone layout.** The office sits on top with a bottom sheet below. Approvals open as a full-screen card with the agent's portrait, a diff snippet and the spend so far.
- **Files view.** File tree and code viewer, a version picker (Coder v1, v2…), a line diff against the previous iteration, a sandboxed preview iframe and a ZIP download.
- **Run history** (last 8 runs) is saved in `localStorage`. Settings live there too. It degrades to memory when storage is blocked.
- **Single-file offline build.** `npm run build:preview` produces `preview.html`: one inline classic `<script>` that runs the whole demo inside a sandboxed iframe with no network and no storage.

## Quick start

```bash
npm install
npm run dev          # wrangler dev (Worker, previews, proxy) on :8787 + Vite on :5173
# open http://localhost:5173 and press "Run demo"
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Type-checks, then builds the app into `dist/` (served by the Worker's static assets) |
| `npm run dev:worker` | Serves `dist/` and the Worker together on :8787, the same way production does |
| `npm test` | Vitest unit tests (orchestrator with a mock LLM, tool calls, checks, budget cap, approvals, injection safety) |
| `npm run test:e2e` | Playwright at 390×844 and 1440×900. Run `npm run build` and `npm run build:preview` first |
| `npm run build:preview` | Builds `preview.html` and prints its sha256 |
| `npm run atlas` | Rebuilds the sprite atlas and office background from `art/raw/` |
| `npm run deploy` | `wrangler deploy` to your own Cloudflare account. Nothing deploys unless you run it |

## Bring your own key

Open **Settings**, choose **Live (your key)**, then pick a preset or enter any OpenAI-compatible endpoint:

| Preset | Base URL | Default model | Route |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | Worker proxy |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | direct (CORS allowed) |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Worker proxy |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | direct |

- **The key stays in your browser.** It lives in session storage unless you tick *Remember on this device*. Each request carries it as an `Authorization` header, either straight to the provider or through the Worker's stateless `/api/llm` proxy. The Worker never stores or logs it, and errors are redacted before they reach the activity log.
- **Prices and a budget cap.** Set the $/1M input and output tokens for your model, plus a budget cap per run (default $0.50). The run stops before it spends more.
- **JSON mode** is requested by default and switches off automatically if the provider rejects `response_format`.
- **Local Ollama:** use the *direct* route, or put `ALLOW_LOCAL_LLM=1` in `.dev.vars` so `wrangler dev` may proxy to `localhost`.
- **GitHub push (optional).** Enter `owner/name`, a branch and a fine-grained token with `contents: write`. The browser calls `api.github.com` directly, so the token never touches the Worker. It's kept for the session only.

## Architecture

```
src/
  engine/            framework-free, runs in the browser and in Node (tests)
    orchestrator.ts  PM → Research → Coder ⇄ Reviewer → Ops; gates, budget, cancel/pause, events
    schema.ts        JSON tool-call extraction + per-tool/per-role validation, safe paths
    prompts.ts       system prompts, per-phase context, <data> fencing of untrusted text
    checks.ts        the Reviewer's real checks (parse5, contrast, links, a11y, JS/CSS syntax, size)
    llm.ts           OpenAI-compatible client: proxy/direct, retries, timeouts, JSON-mode fallback, usage
    diff.ts zip.ts storage.ts
  demo/              DemoLLM: deterministic recorded run (Kopi Senja) incl. a reviewer catch and fix
  office/            canvas renderer: pre-rendered isometric room + sprite atlas, nav graph, lights, rain
  app/               UI controller (vanilla TS), settings, deploy/preview/GitHub
worker/src/          Cloudflare Worker + SQLite Durable Object (one per run) for previews
art/raw/             generated source art; scripts/build-atlas.py slices + packs it
```

**Agent protocol.** Every model turn must be exactly one JSON object: `{"thought", "tool", "args"}`. The tools are `write_file`, `read_file`, `list_files`, `run_checks`, `ask_user`, `handoff` and `finish`, and each role only gets its own subset. Replies are validated against a per-tool schema (required args, types, enums, size limits). An invalid reply is returned to the agent with a precise error, and three invalid replies in a row fail the run. Model calls get retries with backoff on 429/5xx, a 90 s timeout, an abort signal for cancel, and a step cap per agent. The Reviewer's verdict is grounded: when checks fail, the orchestrator sends the work back to the Coder whatever the model says.

**Worker routes:**

| Route | What it does |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/llm` | Stateless OpenAI-compatible proxy. Public https upstreams only, private/loopback hosts refused |
| `GET /api/fetch?url=` | Read-only page fetch for Research. Public hosts only, 1 MB cap, returns stripped text |
| `PUT /api/runs/:id` | Stores the shipped files in that run's SQLite Durable Object. Validated paths, ≤80 files, ≤3 MB, expires after `PREVIEW_TTL_DAYS` through a DO alarm |
| `GET /p/:id/*` | Serves the preview with strict headers (see *Security*) |

**Why a custom canvas renderer instead of Phaser or Pixi?** The office is one pre-rendered isometric room with a handful of sprites, glows and rain. A ~600-line renderer covers that, keeps the bundle around 260 KB and makes the single-file classic-script preview possible. Bundled game engines don't survive that preview's constraints.

**Art.** The room, the five characters (idle, walk front and back, typing from behind, typing from the front, holding a coffee mug) and the portraits were generated as pixel art, chroma-keyed, then sliced. `scripts/build-atlas.py` downsamples with a box filter and a hard alpha, quantises each sprite's palette, removes green fringe and shelf-packs the atlas. Everything is drawn nearest-neighbour.

## Security notes

- **Prompt injection.** User notes, fetched pages and file contents are wrapped in `<data source="…">` blocks, with any attempt to close the fence stripped. Every agent is told that content inside `<data>` is untrusted and never contains instructions. Fetched pages go to Research only, never to the PM. Tool permissions are per role, so the PM and Ops cannot write files and Research can only write under `notes/`. Paths are normalised and anything that escapes the project is refused.
- **Preview isolation.** Generated sites are served from `/p/<runId>/` with:
  - `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; … connect-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms`
  - `nosniff` and `no-referrer`
  - In the app, a `sandbox="allow-scripts allow-forms"` iframe with no `allow-same-origin`

  A generated page therefore can't read the app's storage (where a key may live), can't make network requests and can't navigate the top window. The in-browser fallback preview uses `srcdoc` with the same CSP.
- **Secrets.** API keys and GitHub tokens are never sent to or stored by the Worker, apart from the proxy forwarding the `Authorization` header in flight. Nothing logs request bodies or headers. Worker errors never echo request data.
- **App CSP** (`public/_headers`): `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`. It includes `'unsafe-eval'` for one reason: the Reviewer's JS syntax check *compiles* generated code with `new Function` and never calls it. Without eval, it falls back to a bracket/string/comment balance check.
- **SSRF.** The proxy and the fetcher refuse loopback, private, link-local and metadata hosts. Local LLMs need the explicit `ALLOW_LOCAL_LLM=1` dev flag.

## Roadmap

- Streaming tokens into speech bubbles, and per-agent model choice (a cheap model for PM/Reviewer, a strong one for Coder)
- More task types: small tools with tests, edits to an existing repo (open a PR instead of pushing a branch)
- Headless-browser checks (Lighthouse-style performance, real rendered contrast, screenshot diffs)
- Agents that can ask each other questions, plus a "standup" summary at the meeting table
- Day/night cycle, more office layouts, unlockable decor as runs complete
- Shareable read-only run replays, with the event log stored in the Durable Object

## License

MIT © vhmns · Kode Kecil
