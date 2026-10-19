# Overtime external-agent events (v1)

Overtime's office can show any agent's work, not just its built-in team. An agent (Hermes Agent
first, anything else through this API) posts **events** to an **office**; the office stores them in
its own SQLite Durable Object and streams them to viewers. This file is the contract.

- Schema id: `overtime.events.v1` (`"v": 1`, optional)
- JSON Schema: [`events.schema.json`](events.schema.json), generated from the Worker's validator by
  `npx vite-node scripts/gen-events-schema.ts` (a unit test fails if the two drift)
- Code: `src/ext/schema.ts` (validation), `src/ext/redact.ts`, `src/ext/hermes.ts` (Hermes mapper),
  `src/ext/office-state.ts` (how the office reacts), `worker/src/ext.ts` (routes + Durable Object)

## Offices

An office is long-lived: one per agent install. It keeps every session the agent runs, so a new
`hermes` session (or a Telegram chat, or a cron run) shows up by itself. It is deleted after
`EXT_TTL_DAYS` (default 30) without events, and keeps the newest 50,000 events.

```http
POST /api/ext/runs
{"agent": "hermes", "privacy": "metadata", "name": "My Hermes"}
```

```json
{
  "runId": "of-k2v8x0q1r7aa",
  "ingestToken": "ot_ing_…",      // write access: give it to the agent, keep it private
  "viewToken": "ot_view_…",       // read-only: share it
  "webhookSecret": "ot_whs_…",    // HMAC secret for Hermes outbound webhooks
  "urls": {
    "events":  "https://<host>/api/ext/runs/of-…/events",
    "hermes":  "https://<host>/api/ext/runs/of-…/hermes",
    "webhook": "https://<host>/api/ext/hermes/webhook/of-…",
    "stream":  "wss://<host>/api/ext/runs/of-…/stream",
    "watch":   "https://<host>/watch/of-…#v=ot_view_…"
  }
}
```

`privacy` (`metadata` | `args` | `full`) is applied on arrival to everything that comes through the
Hermes routes (see *Privacy* below). Tokens are stored as SHA-256 hashes; the view token is also kept
in clear so `/share` can hand the viewer link to the agent.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `POST /api/ext/runs` | none (10/min per IP) | Create an office |
| `POST /api/ext/runs/:id/events` | `Authorization: Bearer <ingest>` | Generic events: one, an array, or `{"events":[…]}` |
| `POST /api/ext/runs/:id/hermes` | `Authorization: Bearer <ingest>` | Hermes hook envelopes (the plugin): one, an array, or `{"batch":[…]}` |
| `POST /api/ext/hermes/webhook/:id` | `X-Hermes-Signature-256` | One Hermes outbound-webhook delivery (HMAC, see below) |
| `GET /api/ext/runs/:id/events?after=&session=&limit=` | view or ingest (`Bearer` or `?v=`) | Replay. `session=` includes that session's subagents |
| `GET /api/ext/runs/:id` | view or ingest | Office info and the 50 most recent sessions |
| `GET /api/ext/runs/:id/stream?v=<token>&after=<seq>` | view or ingest | WebSocket: backlog after `seq`, then live `{"type":"events","events":[…]}` |
| `GET /api/ext/runs/:id/share` | ingest | `{ "watch": "<viewer URL>" }` (what `/overtime` prints in Hermes) |

The viewer page is `/watch/<office>#v=<view token>`. The token rides in the URL fragment, so it is
never sent to a server or a referrer.

Every POST answers `{"received", "accepted", "rejected": [{"i", "error"}], "lastSeq"}`. Invalid events
are reported and skipped, the rest are stored.

### Limits

- 256 KB per request, 200 events per request, 16 KB per stored event
- Per office: 120-request burst refilling at 20/s, and a 2,000-event burst refilling at 200/s.
  Over the limit: `429` with `Retry-After`
- Strings are clipped (2,000 chars by default, 4,000 for `text`); plan lists to 40 items

### Redaction

Before anything is stored, every string is scanned and anything that looks like a credential is
replaced with `[redacted]`: OpenAI/OpenRouter/Anthropic-style `sk-…` keys, GitHub tokens
(`ghp_…`, `github_pat_…`), GitLab, Slack, AWS access keys, Google API keys, Hugging Face and Groq
keys, JWTs, `Bearer`/`Basic` credentials, PEM private keys, `password@` in URLs, `*_API_KEY=…`
style assignments, and Overtime's own tokens. Values under keys like `token`, `password`,
`api_key`, `authorization`, `cookie` are dropped whole. The UI escapes everything it renders.

## Event envelope

```json
{
  "v": 1,
  "type": "tool.start",
  "ts": "2026-10-19T09:08:26Z",
  "session": "20261019_090826_7eba2a",
  "agent": "main",
  "id": "optional-idempotency-key",
  "data": { "name": "write_file", "call_id": "call_1jE9", "target": "hello.py" }
}
```

| Field | |
|---|---|
| `type` | One of the types below (required) |
| `data` | The type's payload (required, may be `{}`); unknown fields are dropped |
| `ts` | Epoch ms, epoch seconds or ISO-8601. Default: time of arrival. Far-future values are clamped |
| `session` | The agent's session id (`[\w.:@/-]{1,128}`), default `default`. Groups events into sessions |
| `agent` | `main` (default) or a subagent id from `subagent.start` |
| `id` | Idempotency key: a repeated `id` in the same office is ignored |

Stored events gain `seq` (monotonic per office).

## Types

| Type | `data` (required in **bold**) | What the office does |
|---|---|---|
| `session.start` | `title`, `model`, `platform`, `profile`, `cwd` | Adds the session; viewers that follow switch to it |
| `session.end` | `status` (`completed`/`interrupted`/`failed`), `reason`, `final` | Everyone idles. `final: true` marks the session closed |
| `agent.thinking` | `text` | The PM thinks at its desk |
| `llm.call` | `model`, `provider`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `cost_usd`, `duration_ms`, `finish_reason`, `tool_calls` | Cost meter. Without `cost_usd`, a small price table is used; unknown models count tokens only |
| `tool.start` | **`name`**, `call_id`, `args_summary`, `target` | A character walks to its desk and types (role rules pick who) |
| `tool.end` | **`name`**, **`ok`**, `call_id`, `status`, `duration_ms`, `error`, `output_summary`, `target` | Typing stops; the log shows ✓/✗ and the duration |
| `file.write` | **`path`**, `op` (`write`/`edit`/`patch`/`delete`), `added`, `removed` | The file goes on that character's list; the Code step counts files |
| `plan.update` | **`items`**: `[{ "id", "text", "status": "todo"/"doing"/"done"/"cancelled" }]` | The PM sticks the plan on the whiteboard, then updates stickies in place |
| `subagent.start` | **`id`**, `name`, `role`, `goal`, `child_session` | The subagent borrows the next free desk (Research, Coder, Reviewer, Ops) with its name on the tag; PM hands off at the table |
| `subagent.stop` | **`id`**, `status`, `summary`, `duration_ms`, `tools` | Hands back to the PM; the desk gets its name back |
| `approval.request` | `id`, `command`, `description`, `surface`, `pattern` | The character waits; a read-only "waiting for approval in its own UI" card appears |
| `approval.response` | `id`, `choice` | The card closes |
| `human_input.request` | `id`, `kind` (`clarify`/`sudo`/`approval`), `prompt` | Same, for questions and passwords (never the answer) |
| `human_input.resolved` | `id`, `outcome` | The wait ends |
| `message` | **`role`** (`user`/`assistant`), **`text`** | Logged; the first user message names the session |
| `error` | **`message`**, `kind`, `retryable` | Logged in red |

Events with `agent: "<subagent id>"`, or whose `session` is a subagent's `child_session`, are shown
at that subagent's desk inside the parent session. A subagent's own `session.start/end` never opens a
new office session.

## Roles

Rules map events to the five characters; first match wins. Defaults (`src/ext/roles.ts`, editable
under *Setup → Advanced* in the app):

| Character | Gets |
|---|---|
| PM | `agent.thinking`, `llm.call`, `message`, `plan.update`; tools `todo`, `clarify`, `memory`, `skill_*`, `session_search`, `delegate_task`, `kanban_*` |
| Research | `web_search`, `web_extract`, `x_search`, `browser_*`, `read_file`, `search_files` |
| Coder | `write_file`, `patch`, and `terminal`/`execute_code` unless a rule below matches; `file.write`; any unknown tool |
| Reviewer | `terminal` whose command looks like tests, lint or type checks (`pytest`, `vitest`, `npm run test`, `ruff`, `tsc`, …); `error` |
| Ops | `terminal` with `git push`, `docker`, `kubectl`, `wrangler`, `systemctl`, `crontab`, `deploy`, …; `cronjob_*`, `process_manage` |

A rule is `{"role": "ops", "types": ["tool.start","tool.end"], "tool": "^terminal$", "target": "\\bterraform\\b"}`:
`types` filters event types, `tool` and `target` are case-insensitive regexes on the tool name and
its target (path, URL host or command head).

## Hermes Agent mapping

Both Hermes paths carry the same envelope Hermes uses for shell hooks and outbound webhooks
(`agent/shell_hooks.py` `_payload_fields`, `agent/outbound_webhooks.py` `_serialize_payload`):

```json
{ "hook_event_name": "post_tool_call", "profile": "default", "tool_name": "terminal",
  "tool_input": {"command": "python3 -m pytest -q"}, "session_id": "20261019_090826_7eba2a",
  "cwd": "/srv/app", "extra": {"tool_call_id": "call_l2Lx", "status": "ok", "duration_ms": 177},
  "delivery_id": "3f2c9a…", "timestamp": "2026-10-19T09:08:31Z" }
```

| Hermes hook | Overtime events |
|---|---|
| `on_session_start` | `session.start` (model, platform, profile) |
| `on_session_end` | `session.end` (`completed`/`interrupted`/`failed` from `completed`/`interrupted`/`failed`, reason from `turn_exit_reason`) |
| `on_session_finalize`, `on_session_reset` | `session.end` with `final: true` |
| `agent_loop_stopped` | `session.end` `interrupted` |
| `pre_api_request` | `agent.thinking` |
| `post_api_request` | `llm.call` from `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens`, …), `api_duration`, `response_model`; plus one `tool.start` per assistant tool call (plugin: `extra.tool_calls`; webhooks: the sanitized `response`) |
| `api_request_error` | `error` |
| `pre_tool_call` (webhooks only) | `tool.start` |
| `post_tool_call` | `tool.end` (`status`, `duration_ms`, `error_type`/`error_message`); `file.write` for `write_file`/`patch`; `plan.update` for `todo`/`todo_list` |
| `post_llm_call` | `message` ×2 at `full`, else a short `agent.thinking` |
| `on_interim_message` | `agent.thinking` |
| `subagent_start` / `subagent_stop` | `subagent.start` / `subagent.stop`, keyed by `child_session_id` (`subagent_stop` has no `child_subagent_id`) |
| `pre_approval_request` / `post_approval_response` | `approval.request` / `approval.response` |
| `on_human_input_request` / `on_human_input_resolved` | `human_input.request` / `human_input.resolved` |

Unknown hooks map to nothing, so a newer Hermes never breaks an office. A delivery's
`delivery_id` becomes the events' idempotency keys (Hermes retries a failed delivery once).

### Outbound-webhook signature

Hermes signs each delivery with `X-Hermes-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the raw
body with the shared secret (GitHub style). Overtime verifies it in constant time, rejects
deliveries whose signed `timestamp` is more than 5 minutes off, and drops repeated `delivery_id`s.

```python
expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
```

### Privacy

| Level | What leaves the agent / is kept |
|---|---|
| `metadata` (default) | Tool names, file paths, URL host + path (no query), the command head (`git push`, `npm run test`, `python -m pytest`: subcommands only, never free arguments), statuses, durations, token counts, cost, model, plan item titles (≤80 chars), subagent count/status. No prompts, messages, file contents, full commands or outputs |
| `args` | + tool arguments and full commands (300 chars each; file bodies replaced by their length), subagent goals and summaries, approval commands, error messages |
| `full` | + user/assistant messages (1,000 chars) and tool output summaries (500 chars) |

The plugin applies its `OVERTIME_PRIVACY` level on the Hermes machine; the office applies its own
level again on arrival. The lower of the two wins.

## Approvals

Without remote control an office never answers an approval: Hermes asks in its own UI and the card
is read-only. `approval.request` / `approval.response` events are observations only.

## Remote control (opt-in)

Code: `src/ext/control.ts` (signatures, audit chain), `src/ext/notify.ts`, `src/ext/webpush.ts`,
`worker/src/control.ts` (routes + the `ControlOffice` Durable Object, which extends the office),
`integrations/hermes-overtime/overtime_control.py` (the plugin side), `src/app/control.ts` (UI).

Off until both sides opt in: the office (a paired device ticks *answer approvals* / *send tasks*) and
the Hermes machine (`OVERTIME_REMOTE_APPROVAL=1`, `OVERTIME_REMOTE_TASKS=1`).

### Tokens

| Token | Can |
|---|---|
| view (`ot_view_…`) | read events. Never controls anything |
| ingest (`ot_ing_…`, on the Hermes machine) | write events; register approvals and **read** decisions; claim and acknowledge tasks; pair the *first* device while none is paired |
| control (`ot_ctl_…`, one per paired device) | decide approvals, queue/cancel tasks, change policy and notifications, pair/revoke devices, read the audit log |

Control tokens are stored as SHA-256 hashes and revocable. A pairing link is
`/watch/<office>#v=<view>&c=<control>`; the app moves the control token to local storage and removes
it from the address bar.

### Routes (`/api/ext/runs/:id/control/…`)

| Route | Token | |
|---|---|---|
| `POST enable` `{device}` | ingest, only while no device is paired | Pairs the first device → `{controlToken, deviceId}` |
| `POST devices` `{name}` · `POST devices/:dev/revoke` | control | Pair another device (→ `controlToken`, pairing `watch` link) · revoke |
| `POST policy` `{remoteApproval, remoteTasks}` | control | Both default to `false` |
| `GET state` | control | Policy, notification settings (Telegram token never returned), devices, recent approvals and tasks, VAPID public key |
| `POST approvals` `{request_id, session, surface, command, description, pattern_key, expires_in}` | ingest | The plugin registers a pending approval (409 while remote approval is off). `expires_in` 10–900 s |
| `GET approvals/:rid?wait=0..25` | ingest | Long-poll: `{status, decision}` with `decision = {request_id, command_sha256, choice, by, at, sig}` once decided |
| `POST approvals/:rid/decide` `{choice}` | control | `once`, `session` or `deny` (`always` is refused). First answer wins; expired → 410 |
| `POST approvals/:rid/outcome` `{outcome}` | ingest | `applied`, `stale`, `timeout`, `answered_locally`, `unsupported` |
| `POST commands` `{kind: "run", prompt, confirm: true}` · `{kind: "stop", target, confirm: true}` | control | Queue a task (≤4000 chars, no control characters, ≤5 waiting) or stop a running one |
| `GET commands/next?wait=0..25` | ingest | Claims the oldest queued task: `{id, kind, payload, created_at, by, sig}`. A claim not confirmed within 120 s becomes `lost` and is never handed out again |
| `POST commands/:cid/ack` `{status, run_id, error}` | ingest | `started`, `completed`, `failed`, `cancelled`, `rejected` |
| `POST commands/:cid/cancel` | control | Only while still queued |
| `POST notify` `{settings, telegram: {token, chatId} \| {clear} \| {useServer}}` · `POST notify/test` | control | Settings below; the test bypasses dedupe |
| `POST push/subscribe` `{subscription}` · `POST push/unsubscribe` `{endpoint}` | control | Browser push services only (FCM, Mozilla, Apple, Windows) |
| `GET audit` | control | `{entries, publicKey, verified}` |

Every change pings connected viewers with a content-free `{"type":"control","rev":n}` WebSocket
message; devices then refetch `state`.

### Signatures the plugin checks

Key: `hex(SHA-256(ingest token))` (the office stores exactly this hash). HMAC-SHA256, hex:

```
decision: v1|decision|<office>|<request_id>|<sha256(command)>|<choice>|<device name>|<at ms>
command:  v1|command|<office>|<id>|<kind>|<sha256(payload)>|<created_at ms>
```

The plugin applies a decision only if the signature verifies, `request_id` is its own,
`command_sha256` matches the command it registered, the choice is `once`/`session`/`deny`, and the
head of Hermes' gateway approval queue for that session is still that command. It then calls
`tools.approval.resolve_gateway_approval(session_key, choice)`. Anything else, including a timeout
or a network error, leaves the approval to Hermes.

### Audit log

Entries `{seq, at, kind, subject, detail, by, prev, hash, sig}`: `hash = SHA-256(prev|seq|at|kind|subject|detail|by)`,
`prev` is the previous entry's hash (`genesis` for the first), `sig` is ECDSA P-256 / SHA-256 over
the hash bytes (IEEE P1363, base64url) with the office's key; `publicKey` is SPKI, base64url.
`verifyAudit()` in `src/ext/control.ts` checks the chain.

### Notifications

Settings: `enabled` (default false), `triggers` `{approval, error, stuck, finished}` (defaults
true/true/true/false), `quiet {on, start, end, tz}` (HH:MM, IANA zone, may cross midnight),
`stuckMinutes` (10), `dedupeS` (600), `maxPerHour` (12, per channel). Triggers: `approval.request`
and `human_input.request` → *approval*; `error` and `session.end` with `failed` → *error*;
`session.end` `completed` (main agent, not `final`) → *finished*; a session still `working` with no
events for `stuckMinutes` → *stuck* (the Durable Object alarm, once per quiet stretch). Messages carry
`{title, body, url, tag}`; `url` is the office's `/watch` link. Telegram uses `sendMessage` (HTML,
escaped). Web Push uses VAPID (ES256) and aes128gcm (RFC 8291); a 404/410 from the push service drops
the subscription.

Approval transports: Hermes builds newer than 0.19.0 document `ctx.register_approval_transport(name,
present_fn)` with `security.approval.transport`. Hermes 0.19.0 on PyPI does not have it; the plugin
uses the gateway approval queue above, which is what Hermes' own `/approve` and
`POST /v1/runs/{id}/approval` use.

## Generic example

```bash
OFFICE=of-…; TOKEN=ot_ing_…
curl -X POST https://<host>/api/ext/runs/$OFFICE/events \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '[
  {"type":"session.start","session":"run-1","data":{"model":"my-model","title":"Nightly report"}},
  {"type":"tool.start","session":"run-1","data":{"name":"web_search","call_id":"1"}},
  {"type":"tool.end","session":"run-1","data":{"name":"web_search","call_id":"1","ok":true,"duration_ms":820}},
  {"type":"llm.call","session":"run-1","data":{"model":"openai/gpt-4o-mini","input_tokens":5200,"output_tokens":310}},
  {"type":"session.end","session":"run-1","data":{"status":"completed"}}
]'
```
