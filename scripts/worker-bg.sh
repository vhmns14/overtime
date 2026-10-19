#!/bin/sh
# (re)start wrangler dev in the background for local e2e; pid in /tmp/ot-wrangler.pid
cd "$(dirname "$0")/.."
[ -f /tmp/ot-wrangler.pid ] && kill $(cat /tmp/ot-wrangler.pid) 2>/dev/null
setsid nohup npx wrangler dev --port 8787 --ip 127.0.0.1 --local > /tmp/ot-wrangler.log 2>&1 &
echo $! > /tmp/ot-wrangler.pid
