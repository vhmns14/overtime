# hermes-overtime

A [Hermes Agent](https://hermes-agent.nousresearch.com/) plugin that streams what your agent does to
an [Overtime](../../README.md) office, so you can watch it work in a pixel-art room: research at the
Research desk, edits at the Coder's, tests with the Reviewer, deploys with Ops, plans on the
whiteboard, subagents at borrowed desks, approvals and cost.

- **Observer hooks only.** It registers `on_session_*`, `pre/post_api_request`, `api_request_error`,
  `on_interim_message`, `post_tool_call`, `post_llm_call`, `subagent_start/stop`,
  `pre_approval_request`, `post_approval_response` and `on_human_input_*` (whichever your Hermes
  version knows). Never `pre_tool_call`, `pre_llm_call`, `transform_*` or an approval transport: it
  cannot block, rewrite or approve anything. It registers no tools.
- **Never slows Hermes down.** Hooks build a small envelope and put it on a bounded queue
  (`put_nowait`). One daemon thread batches up to 50 events (or 0.4 s), POSTs them with a 3 s
  timeout, never follows redirects, and drops the batch on failure. After 3 failures in a row it stays
  quiet for 30 s. A full queue drops events instead of waiting. Nothing raises into Hermes.
- **Metadata by default.** See the privacy table in [docs/EVENTS.md](../../docs/EVENTS.md#privacy).
  Secrets that look like keys or tokens are redacted on your machine before sending.
- **Cost from Hermes itself.** Each model call carries Hermes' own estimate
  (`agent.usage_pricing.estimate_usage_cost`), computed on the sender thread.
- One Python file, standard library only. Tested on Hermes 0.19.0.

## Install

Overtime's **Connect Hermes** screen gives you these lines with your office's URL and token filled in:

```bash
mkdir -p ~/.hermes/plugins/hermes-overtime
curl -fsSL https://<your-overtime>/hermes-overtime/plugin.yaml -o ~/.hermes/plugins/hermes-overtime/plugin.yaml
curl -fsSL https://<your-overtime>/hermes-overtime/__init__.py -o ~/.hermes/plugins/hermes-overtime/__init__.py
hermes plugins enable hermes-overtime      # if it asks about overriding built-in tools: answer no

cat >> ~/.hermes/.env <<'EOF'
OVERTIME_URL=https://<your-overtime>/api/ext/runs/<office>/hermes
OVERTIME_TOKEN=ot_ing_…
OVERTIME_PRIVACY=metadata
EOF
```

Restart Hermes (start a new `hermes` session, or restart the gateway). Then:

```bash
hermes overtime test    # sends a test session to the office
hermes overtime         # prints the office's read-only viewer link
```

Inside a session, `/overtime` prints the same link and delivery stats (`/overtime test` sends a test).

| Variable | |
|---|---|
| `OVERTIME_URL` | The office's ingest URL (`…/api/ext/runs/<office>/hermes`) |
| `OVERTIME_TOKEN` | The office's ingest token (`ot_ing_…`). Keep it private |
| `OVERTIME_PRIVACY` | `metadata` (default), `args` or `full` |
| `OVERTIME_TIMEOUT` | Seconds per POST, default 3 (max 10) |

Without `OVERTIME_URL` and `OVERTIME_TOKEN` the plugin loads, sends nothing, and `/overtime` explains
how to connect.

## No code at all: outbound webhooks

Hermes builds that have `hooks.outbound` can POST every hook to Overtime themselves, HMAC-signed.
The Connect screen's **Webhooks** tab gives you the `config.yaml` block and the secret. Hermes 0.19.0
on PyPI does not have outbound webhooks yet; the plugin works there.

## Tests

```bash
cd integrations/hermes-overtime
uv run --no-project --with pytest python -m pytest -q tests
```
