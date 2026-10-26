#!/bin/bash
set -u
cd "$(dirname "$0")"
CHECK_NAME="$1"; shift
PORT="${PORT:-8840}"
PERSIST="/tmp/brain-probe-$PORT-$$"
BACKUP="/tmp/brain-devvars-$PORT-$$"

ENVVARS=()
DEVVARS=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; DEVVARS=("$@"); break; fi
  ENVVARS+=("$1"); shift
done

cp .dev.vars "$BACKUP"
restore() {
  cp "$BACKUP" .dev.vars 2>/dev/null || rm -f .dev.vars
  rm -f "$BACKUP"
  kill "$DEV_PID" 2>/dev/null
  rm -rf "$PERSIST"
}
trap restore EXIT

pkill -f "wrangler dev --ip 127.0.0.1 --port $PORT" >/dev/null 2>&1
sleep 1
rm -rf "$PERSIST"

if [ ${#DEVVARS[@]} -gt 0 ]; then
  : > .dev.vars
  for kv in "${DEVVARS[@]}"; do echo "$kv" >> .dev.vars; done
fi

npx wrangler dev --ip 127.0.0.1 --port "$PORT" --persist-to "$PERSIST" > "/tmp/wrangler-$PORT.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done

env CHECK="$CHECK_NAME" BRAIN_URL="http://127.0.0.1:$PORT/mcp" ${ENVVARS[@]+"${ENVVARS[@]}"} node tools-protocol-check.mjs
STATUS=$?
if [ $STATUS -ne 0 ]; then tail -20 "/tmp/wrangler-$PORT.log"; fi
exit $STATUS
