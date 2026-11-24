#!/usr/bin/env bash
# ==============================================================================
# MONITORING CONFIGURATION VALIDATOR — أكاديمية التميز
# ==============================================================================
# Validates Prometheus rules and Alertmanager config using promtool and amtool.
# Usage:
#   bash deploy/tests/test-monitoring-config.sh
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MON_DIR="$PROJECT_ROOT/deploy/monitoring"

echo "=== 1. Validating Prometheus Alert Rules ==="
if command -v promtool >/dev/null 2>&1; then
  promtool check rules "$MON_DIR/prometheus/alert.rules.yml"
  (cd "$MON_DIR/prometheus" && promtool check config prometheus.yml)
  echo "[OK] Prometheus rules and config syntax valid."
else
  echo "[WARN] promtool not installed. Skipping promtool check."
fi

echo "=== 2. Validating Alertmanager Configuration ==="
if command -v amtool >/dev/null 2>&1; then
  amtool check-config "$MON_DIR/alertmanager/alertmanager.yml"
  echo "[OK] Alertmanager configuration syntax valid."
else
  echo "[WARN] amtool not installed. Skipping amtool check."
fi

echo "=== Monitoring Configuration: PASSED ==="
