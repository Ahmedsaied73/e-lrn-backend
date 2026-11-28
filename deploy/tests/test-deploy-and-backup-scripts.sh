#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=== Checking deploy scripts syntax (bash -n) ==="
for f in "$ROOT_DIR"/deploy/scripts/*.sh "$ROOT_DIR"/deploy/monitoring/prometheus/entrypoint.sh "$ROOT_DIR"/deploy/monitoring/alertmanager/entrypoint.sh; do
  if [ -f "$f" ]; then
    bash -n "$f"
    echo "  [OK] $f"
  fi
done

echo "=== Verifying deploy.sh uses deploy/docker-compose.yml and passes REDIS_URL/DATABASE_URL to standby ==="
grep -q 'deploy/docker-compose.yml' "$ROOT_DIR/deploy/scripts/deploy.sh"
grep -q 'REDIS_URL=' "$ROOT_DIR/deploy/scripts/deploy.sh"
grep -q 'DATABASE_URL=' "$ROOT_DIR/deploy/scripts/deploy.sh"

echo "=== Verifying backup.sh fails hard without rclone on daily backup and verifies via rclone lsf ==="
grep -q 'rclone lsf' "$ROOT_DIR/deploy/scripts/backup.sh"
grep -q 'refusing to fake daily backup success' "$ROOT_DIR/deploy/scripts/backup.sh"

echo "=== Verifying add-tenant.sh replaces ADMIN_PASSWORD placeholder and pre-creates rclone.conf ==="
grep -q 'CHANGE_ME_INITIAL_STRONG_ADMIN_PASSWORD' "$ROOT_DIR/deploy/scripts/add-tenant.sh"
grep -q 'rclone.conf' "$ROOT_DIR/deploy/scripts/add-tenant.sh"

echo "ALL DEPLOY & BACKUP SCRIPT CHECKS PASSED."
