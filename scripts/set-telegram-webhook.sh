#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Missing TELEGRAM_BOT_TOKEN."
  echo "Export it before running this script."
  exit 1
fi

if [[ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  echo "Missing TELEGRAM_WEBHOOK_SECRET."
  echo "Export it before running this script."
  exit 1
fi

WEBHOOK_URL="${ATLAS_WEBHOOK_URL:-${1:-}}"

if [[ -z "${WEBHOOK_URL}" ]]; then
  echo "Missing webhook URL."
  echo "Set ATLAS_WEBHOOK_URL or pass the full webhook URL as the first argument."
  echo "Example: bash scripts/set-telegram-webhook.sh https://atlas.example.com/api/telegram/webhook"
  exit 1
fi

ALLOWED_UPDATES_JSON="${TELEGRAM_ALLOWED_UPDATES_JSON:-[\"message\",\"edited_message\"]}"
SET_WEBHOOK_ENDPOINT="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
WEBHOOK_INFO_ENDPOINT="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"

echo "Registering Telegram webhook at ${WEBHOOK_URL}"

curl --silent --show-error --fail-with-body \
  -X POST "${SET_WEBHOOK_ENDPOINT}" \
  -H "content-type: application/json" \
  -d "$(cat <<EOF
{
  "url": "${WEBHOOK_URL}",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ${ALLOWED_UPDATES_JSON}
}
EOF
)"

echo
echo
echo "Current Telegram webhook info:"

curl --silent --show-error --fail-with-body "${WEBHOOK_INFO_ENDPOINT}"

echo
