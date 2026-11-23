#!/usr/bin/env bash
# ==============================================================================
# EMERGENCY ROLLBACK SCRIPT — أكاديمية التميز
# ==============================================================================
# Usage:
#   bash rollback.sh [--tag <PREVIOUS_SHA>]
# ==============================================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/teacher-app}"
cd "$APP_DIR"

TARGET_TAG="${1:-}"

if [ -z "$TARGET_TAG" ]; then
  if [ -f .previous_tag ]; then
    TARGET_TAG=$(cat .previous_tag)
  else
    echo "[FATAL] No previous tag found in .previous_tag and no --tag supplied."
    exit 1
  fi
fi

if [ "$TARGET_TAG" == "initial" ]; then
  echo "[FATAL] Cannot rollback: current version is initial deployment."
  exit 1
fi

echo "=== Rolling back to image tag: ${TARGET_TAG} ==="
bash deploy/scripts/deploy.sh --tag "$TARGET_TAG"
echo "=== Rollback complete ==="
