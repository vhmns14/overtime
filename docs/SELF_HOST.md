# Self-hosting Overtime (step by step)

This guide is written so that an AI agent (for example Hermes itself, with a terminal tool) can follow it from top to bottom. Every step has a command and a check. Do the steps in order. Stop at a **Check** that fails and fix it before going on.

You will end up with:

1. an Overtime server (Docker on your own machine, **or** a Cloudflare Worker),
2. reachable from the machine where Hermes runs,
3. the `hermes-overtime` plugin installed and connected to an office,
4. optionally: remote approvals, tasks sent from Overtime through Hermes' API server, Telegram and Web Push notifications.

Conventions used below:

| Placeholder | Meaning |
|---|---|
| `$OT` | The public base URL of your Overtime, no trailing slash. Examples: `https://overtime.example.com`, `https://overtime.<you>.workers.dev`, `http://127.0.0.1:8787` |
| `$HH` | Hermes' home directory: `$HERMES_HOME` or `~/.hermes` |

Requirements: `git`, `curl`, `sh`. Docker path: Docker with Compose v2. Cloudflare path: Node.js 20+ and a Cloudflare account. The Hermes machine needs Hermes Agent 0.19.0 or newer.

---

## 0. Get the code

```bash
git clone https://github.com/vhmns14/overtime.git
cd overtime
```

**Check:** `ls wrangler.toml docker-compose.yml integrations/hermes-overtime/install.sh` lists all three files.

Pick **one** of path A (Docker) or path B (Cloudflare).

---

## A. Docker Compose (your own server, no Cloudflare account)

The image runs the same Worker and SQLite Durable Objects as Cloudflare, inside `workerd` (Cloudflare's open-source runtime, through `wrangler dev --local`). Data lives in the `overtime-data` volume and survives restarts and upgrades.

### A1. Optional settings

Create `.env` next to `docker-compose.yml` only if you need any of these (all optional):

```bash
cat > .env <<'EOF'
# public URL used in notification links (set it when Overtime sits behind a proxy or tunnel)
PUBLIC_URL=https://overtime.example.com
# master key for settings at rest (the Telegram bot token). Any long random string.
OVERTIME_SECRET_KEY=change-me-to-a-long-random-string
# Web Push keys for every office (otherwise each office generates its own pair)
# VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# VAPID_SUBJECT=mailto:you@example.com
# a server-wide Telegram bot, used only by the offices listed (comma-separated office ids, or *)
# TELEGRAM_BOT_TOKEN=123456789:AA...
# TELEGRAM_CHAT_ID=123456789
# OVERTIME_TELEGRAM_OFFICES=*
EOF
chmod 600 .env
```

Generate a random key with `openssl rand -base64 32`. Generate VAPID keys with `node scripts/vapid-keys.mjs` (or `npm run vapid`; needs Node on the host, otherwise skip them: offices make their own).

### A2. Start it

```bash
docker compose up -d --build
```

**Check:** within about a minute,

```bash
curl -fsS http://127.0.0.1:8787/api/health
# {"ok":true,"service":"overtime","previews":true,"ext":true}
```

`docker compose ps` shows the service as `healthy`.

Upgrading later: `git pull && docker compose up -d --build`. The volume keeps every office and building.

The port is published on `127.0.0.1` only (`OVERTIME_BIND`, default `127.0.0.1`): a reverse proxy or tunnel on the same machine reaches it, the internet does not. Settings from `.env` reach the Worker through a private file, never the process list; `.env` is git-ignored.

Without Docker, on any machine with Node 20+: `npm ci && npm run build && npm run selfhost` (data in `./.overtime-data`, or set `OVERTIME_DATA`). The same environment variables apply.

### A3. Make it reachable from Hermes

| Where Hermes runs | What to use as `$OT` |
|---|---|
| The same machine | `http://127.0.0.1:8787`. Nothing else to do |
| Another machine on a private network you trust | `http://<server-ip>:8787`: the compose file publishes the port on 127.0.0.1 only, so add `OVERTIME_BIND=0.0.0.0` (or the server's private IP) to `.env` and open the port to that network only. Docker-published ports bypass host firewalls such as ufw |
| Anywhere else (a VPS, a phone you want to approve from) | HTTPS through a reverse proxy or a tunnel, below |

HTTPS is needed for Web Push in the browser and recommended for everything else (tokens travel in headers).

A reverse proxy with automatic TLS (Caddy):

```bash
# /etc/caddy/Caddyfile
overtime.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Or a Cloudflare Tunnel, which needs no open ports:

```bash
cloudflared tunnel --url http://127.0.0.1:8787     # quick test: prints a https://….trycloudflare.com URL
```

For a permanent tunnel use a named tunnel (`cloudflared tunnel create overtime`, route a hostname to `http://127.0.0.1:8787`). WebSockets (the live office) work through both.

Set `PUBLIC_URL=$OT` in `.env` and run `docker compose up -d` again so notification links use the public URL.

**Check (from the Hermes machine):** `curl -fsS $OT/api/health` returns `{"ok":true,…}`.

Continue at **step 1**.

---

## B. Cloudflare Workers (deploy with wrangler)

The free Workers plan is enough. SQLite Durable Objects are available on it.

### B1. Install and log in

```bash
npm ci
npx wrangler login              # opens a browser; on a headless box set CLOUDFLARE_API_TOKEN instead
npx wrangler whoami
```

**Check:** `wrangler whoami` prints your account.

With an API token instead of a browser login, the token needs *Workers Scripts: Edit* (and *Account Settings: Read*). Export it as `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if you have several accounts).

### B2. Secrets (all optional)

Set only the ones you want. Each command asks for the value on stdin:

```bash
npx wrangler secret put OVERTIME_SECRET_KEY      # long random string: key for settings at rest
npx wrangler secret put VAPID_PUBLIC_KEY         # from: node scripts/vapid-keys.mjs
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT            # mailto:you@example.com
npx wrangler secret put TELEGRAM_BOT_TOKEN       # a server-wide bot (optional; users can also add their own bot per office)
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put OVERTIME_TELEGRAM_OFFICES   # office ids allowed to use that bot, comma-separated, or *
```

For an agent: pipe the value, for example `printf '%s' "$KEY" | npx wrangler secret put OVERTIME_SECRET_KEY`. Secrets set before the first deploy are kept; if `secret put` says the Worker does not exist yet, run B3 first and then set them.

`PUBLIC_URL` is not secret. Add it under `[vars]` in `wrangler.toml` when you use a custom domain (default: the origin the office was opened from).

### B3. Deploy

```bash
npm run deploy                  # npm run build && wrangler deploy
```

The Durable Object migrations in `wrangler.toml` run on deploy, in order: `v1` (previews), `v2` (offices, `ExtOffice`; remote control lives in the same class and needs no migration), `office-buildings-v1` (buildings, `ExtBuilding`). Never remove or reorder those `[[migrations]]` blocks: Cloudflare refuses a deploy that would.

**Check:** the deploy prints `https://overtime.<subdomain>.workers.dev`. That is `$OT`. Then

```bash
curl -fsS $OT/api/health
```

returns `{"ok":true,…}`.

A Worker is public on the internet, so Hermes on any machine can reach it. A custom domain is optional (*Workers & Pages → overtime → Settings → Domains & Routes*).

**One click instead:** the README's *Deploy to Cloudflare* button forks the repo into your GitHub and deploys it with the same `wrangler.toml`. Add the secrets afterwards in the dashboard (*Settings → Variables and Secrets*) or with B2.

Continue at **step 1**.

---

## 1. Create an office

Either in a browser: open `$OT`, press **Connect Hermes**, choose a privacy level (*metadata* is the default and recommended), and keep the screen open. It shows the office's URL and ingest token.

Or let the installer create one (no browser needed), in step 2 with `--server $OT --create`.

To create one with curl:

```bash
curl -fsS -X POST $OT/api/ext/runs -H 'content-type: application/json' \
  -d '{"agent":"hermes","privacy":"metadata","name":"My Hermes"}'
# {"runId":"of-…","ingestToken":"ot_ing_…","viewToken":"ot_view_…","webhookSecret":"…",…}
```

Keep `ingestToken` private: it can write events to the office (and, with remote control on, read its decisions). `viewToken` only reads.

---

## 2. Install the plugin on the Hermes machine (`install.sh`)

Run this **on the machine where Hermes runs**:

```bash
# an office you created in step 1
curl -fsSL $OT/hermes-overtime/install.sh | sh -s -- \
  --url $OT/api/ext/runs/<office>/hermes --token ot_ing_…

# or: create a new office and connect to it in one go
curl -fsSL $OT/hermes-overtime/install.sh | sh -s -- --server $OT --create --name "My Hermes"
```

What it does:

1. downloads `plugin.yaml`, `__init__.py` and `overtime_control.py` into `$HH/plugins/hermes-overtime/` (the control file does nothing unless you opt in, step 4),
2. writes `OVERTIME_URL`, `OVERTIME_TOKEN` and `OVERTIME_PRIVACY` into `$HH/.env` (older `OVERTIME_*` lines are replaced; the file is set to mode 600),
3. runs `hermes plugins enable hermes-overtime` when `hermes` is on `PATH`,
4. posts a tiny test session, and prints the office's read-only viewer link.

Options: `--privacy metadata|args|full`, `--hermes-home DIR`, `--no-enable`, `--no-test`, `--remote-approval`, `--remote-tasks` (step 4). Run it again any time; it is idempotent.

**Check:** the installer ends with `overtime: done.` and `test event delivered`. A session named after the installer appears in the office in the browser.

If `hermes plugins enable` asks whether the plugin may override built-in tools, answer **no**: the plugin only observes.

---

## 3. Restart Hermes and verify (`hermes overtime test`)

Hermes reads `.env` and plugins at start:

```bash
# CLI: just start a new session.  Gateway (Telegram, Discord, API server…): restart it, e.g.
hermes gateway run          # or: systemctl --user restart hermes-gateway (whatever runs your gateway)
```

Then:

```bash
hermes overtime test
# Overtime answered HTTP 200. Check the office: a test session should appear.
hermes overtime            # prints the office's viewer link
```

Inside a Hermes session, `/overtime` prints the same link and `/overtime test` sends a test session.

**Check:** `hermes overtime test` prints `HTTP 200`, and the test session shows up in the office. Then run any real task in Hermes; the office leaves *Waiting for the first event…* and the characters start working.

If it fails:

| Output | Fix |
|---|---|
| `Could not reach Overtime: URLError` / `ConnectionRefused` | `$OT` is not reachable from this machine: redo A3, test with `curl $OT/api/health` |
| `HTTP 401` | Wrong token: rerun `install.sh` with the token from the Connect screen |
| `HTTP 404` | The office expired (30 days without events) or the URL is wrong: create a new office (step 1) |
| `hermes: unknown command overtime` | The plugin is not enabled: `hermes plugins enable hermes-overtime`, and check `$HH/plugins/hermes-overtime/plugin.yaml` exists |

---

## 4. Optional: remote control

Off by default, and **both sides must opt in**: the office (in the browser) and Hermes (environment variables). Without the Hermes side the plugin stays observer-only and never loads its control file.

### 4a. Turn it on in the office

In the browser that owns the office: **Remote control → Turn on remote control**, name the device, then tick what Overtime may do: *Answer Hermes' approvals* and/or *Send tasks to Hermes*. This browser becomes the first paired device. Pair a phone from there with **Create pairing link**.

An agent without a browser can do the same through the API (the first device may only be paired with the ingest token while no device is paired):

```bash
curl -fsS -X POST $OT/api/ext/runs/<office>/control/enable -H "authorization: Bearer ot_ing_…" \
  -H 'content-type: application/json' -d '{"device":"Setup script"}'
# → {"deviceId":"…","controlToken":"ot_ctl_…",…}
curl -fsS -X POST $OT/api/ext/runs/<office>/control/policy -H "authorization: Bearer ot_ctl_…" \
  -H 'content-type: application/json' -d '{"remoteApproval":true,"remoteTasks":true}'
# then hand a pairing link to the human (a one-time code, valid 10 minutes; the phone swaps it for its own control token):
curl -fsS -X POST $OT/api/ext/runs/<office>/control/devices -H "authorization: Bearer ot_ctl_…" \
  -H 'content-type: application/json' -d '{"name":"My phone"}'
# → {"watch":"$OT/watch/<office>#v=…&p=ot_pair_…","expiresAt":…}   send this link privately; it works once
```

Prefer the browser when a human is around: a control token belongs to whoever holds it.

### 4b. Remote approvals (`OVERTIME_REMOTE_APPROVAL`)

On the Hermes machine:

```bash
cat >> $HH/.env <<'EOF'
OVERTIME_REMOTE_APPROVAL=1
EOF
```

(or rerun `install.sh … --remote-approval`). Restart the gateway.

This covers **gateway** sessions (Telegram, Discord, Slack, the API server). CLI sessions keep asking in the terminal. When a dangerous command needs approval, the office shows **Approve once / Approve for this session / Deny**; Hermes keeps asking in its own UI too and the first answer wins. On a timeout, a network error or a bad signature the plugin does nothing and Hermes' normal approval carries on. Overtime never approves on its own and never offers *always*.

Optional: `OVERTIME_APPROVAL_WAIT=<seconds>` (default: Hermes' `approvals.timeout` minus 5 s, at most 900).

### 4c. Send tasks (`API_SERVER_ENABLED`, `API_SERVER_KEY`)

Tasks start as new runs through **Hermes' own API server** (`POST /v1/runs`), so turn that on:

```bash
cat >> $HH/.env <<EOF
OVERTIME_REMOTE_TASKS=1
API_SERVER_ENABLED=true
API_SERVER_KEY=$(openssl rand -hex 32)
EOF
```

(or `install.sh … --remote-tasks` plus the two `API_SERVER_*` lines). Restart the gateway: the plugin's task bridge runs inside `hermes gateway` and long-polls the office. To run the bridge on its own instead: `hermes overtime bridge`.

Optional on the Hermes side:

| Variable | Default |
|---|---|
| `API_SERVER_PORT` / `OVERTIME_HERMES_API` | `8642` / `http://127.0.0.1:$API_SERVER_PORT` |
| `OVERTIME_REMOTE_COMMANDS` | `run,stop` (allowed task kinds) |
| `OVERTIME_ALLOW_SLASH` | off (prompts starting with `/` are refused) |
| `OVERTIME_TASK_MAX_AGE` | `3600` (seconds; older queued tasks are refused) |
| `OVERTIME_TASK_MAX_CHARS` | `4000` |

The API server listens on `127.0.0.1` by default. Keep it that way: the bridge calls it locally, and nothing needs to reach it from outside.

**Check:** in the office, type a small prompt in the task box under the panel, confirm, and watch it go *queued → claimed → running → done*. A new session appears in the office.

### 4d. Notifications (Telegram, Web Push)

In **Remote control → Notifications**: switch them on, choose triggers (approval or input waiting, error, stuck, finished, budget exceeded), quiet hours, and optional daily/monthly budgets. Then:

- **Telegram:** paste your own bot token (from @BotFather) and your chat id, or use the server-wide bot if the deployment set one (B2 / A1). The token is stored encrypted and never shown again.
- **Web Push:** **Enable push here** on each device (HTTPS required; on Android, Chrome shows them with the tab closed).

**Send a test** reports the result per channel. Stuck sessions and budgets are checked by the office itself, so no tab has to stay open. Budgets set in *Insights → Alerts* on a paired device are copied to the notifications too.

---

## 5. Optional: several Hermes installs as one building

In the office: **Building** → create it (your office becomes floor 1) → **Add another Hermes** → copy the one-line installer and run it on that machine (it is the `install.sh` line from step 2 with that floor's own office and token). **Copy read-only building link** shares every floor read-only.

---

## 6. Final checklist

- [ ] `curl -fsS $OT/api/health` returns `ok: true` from the Hermes machine
- [ ] `hermes overtime test` prints `HTTP 200` and the test session appears in the office
- [ ] a real Hermes task plays out in the office
- [ ] (if enabled) an approval from a gateway session appears in the office and **Approve once** is applied in Hermes
- [ ] (if enabled) a task sent from the office runs and ends as *done*
- [ ] (if enabled) **Send a test** in Notifications reaches Telegram / this device

Security notes: the ingest token stays on the Hermes machine; the viewer link can never control anything; control tokens are per device, hashed and revocable; every control action is in the signed audit log (*Remote control → Audit log*). Offices are deleted after `EXT_TTL_DAYS` (default 30) days without events.
