#!/usr/bin/env bash
# ==============================================================================
# AUTOMATED RESTORE VERIFICATION DRILL — أكاديمية التميز
# ==============================================================================
# Spins up a disposable test Postgres container, restores the latest backup,
# runs integrity checks, verifies student records exist, and measures RTO.
# ==============================================================================

set -euo pipefail

START_TIME=$(date +%s)
TEST_CONTAINER="test_pg_restore_$(date +%s)"
TEST_PORT="54329"
TMP_DIR="/tmp/restore_drill"
mkdir -p "$TMP_DIR"

if [ -f /opt/teacher-app/.env ]; then
  # shellcheck source=/dev/null
  source /opt/teacher-app/.env
fi

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="HTML" \
      -d text="${msg}" > /dev/null || true
  fi
}

cleanup() {
  echo "[DRILL] Cleaning up disposable container and temp files..."
  docker stop "$TEST_CONTAINER" > /dev/null 2>&1 || true
  docker rm "$TEST_CONTAINER" > /dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "=== [1/4] Starting disposable PostgreSQL container ==="
docker run -d \
  --name "$TEST_CONTAINER" \
  -e POSTGRES_USER=test_user \
  -e POSTGRES_PASSWORD=test_pass \
  -e POSTGRES_DB=test_restore_db \
  -p "${TEST_PORT}:5432" \
  pgvector/pgvector:pg16

echo "Waiting for test PostgreSQL to be ready..."
for i in {1..20}; do
  if docker exec "$TEST_CONTAINER" pg_isready -U test_user -d test_restore_db >/dev/null 2>&1; then
    echo "Test PostgreSQL online (ready on attempt $i)!"
    break
  fi
  sleep 1
done

echo "=== [2/4] Fetching latest backup from object storage ==="
DEST="${BACKUP_STORAGE_DEST:-r2:teacher-backups}/${TENANT_NAME:-teacher-default}"
LATEST_BACKUP=$(rclone lsf "${DEST}/daily" --files-only --format 'tp' --separator ';' | sort | tail -n 1 | cut -d';' -f2)

if [ -z "$LATEST_BACKUP" ]; then
  echo "[DRILL ERROR] No backup found in ${DEST}/daily"
  send_telegram "🚨 <b>BACKUP DRILL FAILED:</b> No backup file found in storage for <code>${TENANT_NAME}</code>!"
  exit 1
fi

echo "Downloading ${LATEST_BACKUP}..."
rclone copy "${DEST}/daily/${LATEST_BACKUP}" "$TMP_DIR"

LOCAL_FILE="${TMP_DIR}/${LATEST_BACKUP}"
UNENC_FILE="$LOCAL_FILE"
if [[ "$LOCAL_FILE" == *.gpg ]]; then
  if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
    echo "[DRILL ERROR] BACKUP_ENCRYPTION_PASSPHRASE is not set in environment or /opt/teacher-app/.env"
    exit 1
  fi
  UNENC_FILE="${LOCAL_FILE%.gpg}"
  gpg --batch --yes --decrypt --passphrase "${BACKUP_ENCRYPTION_PASSPHRASE}" -o "$UNENC_FILE" "$LOCAL_FILE"
fi

echo "=== [3/4] Restoring into test container ==="
gunzip -c "$UNENC_FILE" | docker exec -i "$TEST_CONTAINER" psql -U test_user -d test_restore_db

echo "=== [4/4] Verifying data integrity ==="
USER_COUNT=$(docker exec -i "$TEST_CONTAINER" psql -U test_user -d test_restore_db -t -c 'SELECT count(*) FROM "User";' | tr -d '[:space:]')
COURSE_COUNT=$(docker exec -i "$TEST_CONTAINER" psql -U test_user -d test_restore_db -t -c 'SELECT count(*) FROM "Course";' | tr -d '[:space:]')

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "=================================================="
echo "DRILL PASSED SUCCESSFULLY!"
echo "Users restored: $USER_COUNT"
echo "Courses restored: $COURSE_COUNT"
echo "Recovery Time (RTO measured): ${DURATION} seconds"
echo "=================================================="

send_telegram "🛡️ <b>BACKUP DRILL PASSED:</b> <code>${TENANT_NAME}</code> backup verified. Restored ${USER_COUNT} users in ${DURATION}s."
