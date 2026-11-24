#!/bin/sh
set -e

TEMPLATE_FILE="/etc/alertmanager/alertmanager.yml.template"
CONFIG_FILE="/tmp/alertmanager.yml"

if [ -f "$TEMPLATE_FILE" ]; then
  sed -e "s|\${TELEGRAM_BOT_TOKEN}|${TELEGRAM_BOT_TOKEN:-}|g" \
      -e "s|\${TELEGRAM_CHAT_ID}|${TELEGRAM_CHAT_ID:-123456789}|g" \
      "$TEMPLATE_FILE" > "$CONFIG_FILE"
else
  CONFIG_FILE="/etc/alertmanager/alertmanager.yml"
fi

exec /bin/alertmanager --config.file="$CONFIG_FILE" --storage.path=/alertmanager "$@"
