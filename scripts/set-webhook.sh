#!/usr/bin/env bash
# Point Telegram at the deployed worker. Run this once, after `npm run deploy` and after
# TELEGRAM_WEBHOOK_SECRET has been stored with `wrangler secret put`.
#
#   ./scripts/set-webhook.sh                       # reads the URL from wrangler
#   URL=https://brain.example.com ./scripts/set-webhook.sh
set -euo pipefail

URL=${URL:-$(npx wrangler deployments view 2>/dev/null | grep -o 'https://[a-z0-9.-]*workers\.dev' | head -1)}
if [ -z "${URL}" ]; then
  echo "Could not read the workers.dev URL from wrangler."
  echo "Run it yourself with the URL you actually serve: URL=https://... ./scripts/set-webhook.sh"
  exit 1
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then read -rp "Bot token from @BotFather: " -s TELEGRAM_BOT_TOKEN; echo; fi
if [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  read -rp "TELEGRAM_WEBHOOK_SECRET (the exact value you stored): " -s TELEGRAM_WEBHOOK_SECRET; echo
fi

curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${URL}/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
echo
echo "Telegram will now deliver to ${URL}/telegram/webhook"
