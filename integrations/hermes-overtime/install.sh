#!/bin/sh
# Overtime ← Hermes: installs the hermes-overtime plugin (observer hooks only) on this machine and
# connects it to an Overtime office. Safe to run again: it replaces its own files and settings.
#
#   # connect to an office you already have (values from Overtime's Connect screen or a building floor)
#   curl -fsSL https://<overtime>/hermes-overtime/install.sh | sh -s -- \
#     --url https://<overtime>/api/ext/runs/<office>/hermes --token ot_ing_…
#
#   # or let the installer create a new office on your Overtime server
#   curl -fsSL https://<overtime>/hermes-overtime/install.sh | sh -s -- --server https://<overtime> --create
#
# Options: --privacy metadata|args|full (default metadata) · --name "My Hermes" (with --create)
#          --hermes-home DIR (default $HERMES_HOME or ~/.hermes) · --no-enable · --no-test
#          --remote-approval · --remote-tasks   opt in to remote control (also turn it on in the office;
#          --remote-tasks also needs API_SERVER_ENABLED=true and API_SERVER_KEY in the same .env)
# Needs: sh, curl. Uses python3 for JSON when it is there (Hermes always has it).
set -eu

URL="" TOKEN="" PRIVACY="metadata" SERVER="" CREATE=0 NAME="" ENABLE=1 TEST=1 RAPPROVAL=0 RTASKS=0
HH="${HERMES_HOME:-$HOME/.hermes}"

say() { printf '%s\n' "overtime: $*"; }
die() { printf '%s\n' "overtime: error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --privacy) PRIVACY="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --hermes-home) HH="${2:-}"; shift 2 ;;
    --no-enable) ENABLE=0; shift ;;
    --no-test) TEST=0; shift ;;
    --remote-approval) RAPPROVAL=1; shift ;;
    --remote-tasks) RTASKS=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
case "$PRIVACY" in metadata|args|full) ;; *) die "--privacy must be metadata, args or full" ;; esac

json_get() { # json_get <key> : reads JSON on stdin, prints one top-level string value
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1], ""); print(v if isinstance(v, str) else "")' "$1"
  else
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
  fi
}

if [ "$CREATE" = 1 ]; then
  [ -n "$SERVER" ] || die "--create needs --server https://<your overtime>"
  SERVER="${SERVER%/}"
  body=$(printf '{"agent":"hermes","privacy":"%s","name":"%s"}' "$PRIVACY" "$(printf '%s' "${NAME:-$(hostname 2>/dev/null || echo Hermes)}" | tr -d '"\\' | cut -c1-60)")
  resp=$(curl -fsS -X POST "$SERVER/api/ext/runs" -H 'content-type: application/json' -d "$body") || die "could not create an office on $SERVER"
  office=$(printf '%s' "$resp" | json_get runId)
  TOKEN=$(printf '%s' "$resp" | json_get ingestToken)
  [ -n "$office" ] && [ -n "$TOKEN" ] || die "unexpected answer from $SERVER: $resp"
  URL="$SERVER/api/ext/runs/$office/hermes"
  say "created office $office on $SERVER"
fi

[ -n "$URL" ] && [ -n "$TOKEN" ] || die "give --url and --token (from Overtime's Connect screen), or --server <url> --create"
printf '%s' "$URL" | grep -Eq '^https?://[^/]+/api/ext/runs/of-[a-z0-9]{8,24}/hermes$' || die "--url should look like https://<overtime>/api/ext/runs/of-…/hermes"
printf '%s' "$TOKEN" | grep -Eq '^ot_ing_[A-Za-z0-9_-]{16,}$' || die "--token should be the office's ingest token (ot_ing_…)"
ORIGIN=$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')

# 1. the plugin: two files, no dependencies
DIR="$HH/plugins/hermes-overtime"
mkdir -p "$DIR"
for f in plugin.yaml __init__.py; do
  curl -fsSL "$ORIGIN/hermes-overtime/$f" -o "$DIR/$f.tmp" || die "could not download $ORIGIN/hermes-overtime/$f"
  mv "$DIR/$f.tmp" "$DIR/$f"
done
# the remote-control module: loaded only when OVERTIME_REMOTE_APPROVAL / OVERTIME_REMOTE_TASKS is set
if curl -fsSL "$ORIGIN/hermes-overtime/overtime_control.py" -o "$DIR/overtime_control.py.tmp" 2>/dev/null; then
  mv "$DIR/overtime_control.py.tmp" "$DIR/overtime_control.py"
else
  rm -f "$DIR/overtime_control.py.tmp"
  [ "$RAPPROVAL$RTASKS" = "00" ] || die "this Overtime server does not serve overtime_control.py (remote control needs a newer Overtime)"
fi
say "plugin installed in $DIR"

# 2. settings in $HERMES_HOME/.env (older OVERTIME_* lines are replaced)
ENVF="$HH/.env"
touch "$ENVF"
tmp="$ENVF.overtime.tmp"
CTLRE='OVERTIME_URL|OVERTIME_TOKEN|OVERTIME_PRIVACY'
[ "$RAPPROVAL" = 1 ] && CTLRE="$CTLRE|OVERTIME_REMOTE_APPROVAL"
[ "$RTASKS" = 1 ] && CTLRE="$CTLRE|OVERTIME_REMOTE_TASKS"
grep -v -E "^($CTLRE)=" "$ENVF" > "$tmp" || true
{
  cat "$tmp"
  printf 'OVERTIME_URL=%s\nOVERTIME_TOKEN=%s\nOVERTIME_PRIVACY=%s\n' "$URL" "$TOKEN" "$PRIVACY"
  [ "$RAPPROVAL" = 1 ] && printf 'OVERTIME_REMOTE_APPROVAL=1\n'
  [ "$RTASKS" = 1 ] && printf 'OVERTIME_REMOTE_TASKS=1\n'
  true
} > "$ENVF"
rm -f "$tmp"
chmod 600 "$ENVF" 2>/dev/null || true
say "settings written to $ENVF (privacy: $PRIVACY)"
if [ "$RTASKS" = 1 ] && ! grep -q '^API_SERVER_ENABLED=true' "$ENVF"; then
  say "note: --remote-tasks starts runs through Hermes' API server: add API_SERVER_ENABLED=true and API_SERVER_KEY=<long random key> to $ENVF"
fi

# 3. enable it (observer hooks only: answer "no" to overriding built-in tools)
HERMES=""
command -v hermes >/dev/null 2>&1 && HERMES=hermes
if [ "$ENABLE" = 1 ]; then
  if [ -n "$HERMES" ]; then
    HERMES_HOME="$HH" $HERMES plugins enable hermes-overtime </dev/null >/dev/null 2>&1 && say "plugin enabled" || say "could not run 'hermes plugins enable hermes-overtime': run it yourself"
  else
    say "hermes is not on PATH: run 'hermes plugins enable hermes-overtime' where Hermes is installed"
  fi
fi

# 4. check the connection: a tiny test session shows up in the office
if [ "$TEST" = 1 ]; then
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sid="overtime-install-$(date +%s)"
  batch=$(printf '{"batch":[{"hook_event_name":"on_session_start","session_id":"%s","extra":{"model":"installer","platform":"cli"},"timestamp":"%s"},{"hook_event_name":"on_session_end","session_id":"%s","extra":{"completed":true},"timestamp":"%s"}]}' "$sid" "$now" "$sid" "$now")
  if curl -fsS -X POST "$URL" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$batch" >/dev/null; then
    say "test event delivered"
  else
    die "Overtime did not accept the test event: check that this machine can reach $ORIGIN and that the token is right"
  fi
fi

SHARE=$(printf '%s' "$URL" | sed -E 's#/hermes$#/share#')
WATCH=$(curl -fsS "$SHARE" -H "authorization: Bearer $TOKEN" 2>/dev/null | json_get watch || true)
say "done. Restart Hermes (a new 'hermes' session, or restart the gateway) and run any task."
[ -n "$WATCH" ] && say "watch it here (read-only link): $WATCH"
exit 0
