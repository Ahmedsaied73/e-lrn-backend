#!/bin/sh
set -e

TEMPLATE_FILE="/etc/prometheus/prometheus.yml.template"
CONFIG_FILE="/tmp/prometheus.yml"

if [ -f "$TEMPLATE_FILE" ]; then
  sed -e "s|\${METRICS_TOKEN}|${METRICS_TOKEN:-}|g" \
      "$TEMPLATE_FILE" > "$CONFIG_FILE"
else
  CONFIG_FILE="/etc/prometheus/prometheus.yml"
fi

exec /bin/prometheus \
  --config.file="$CONFIG_FILE" \
  --storage.tsdb.path=/prometheus \
  --web.console.libraries=/usr/share/prometheus/console_libraries \
  --web.console.templates=/usr/share/prometheus/consoles \
  --storage.tsdb.retention.time=30d \
  "$@"
