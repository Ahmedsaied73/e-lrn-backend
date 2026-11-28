#!/usr/bin/env bash
# ==============================================================================
# ENCRYPTED DATABASE BACKUP SCRIPT — أكاديمية التميز
# ==============================================================================
# Dumps PostgreSQL -> compresses with gzip -> encrypts with GPG -> uploads to R2
# Retention: 7 daily, 4 weekly, 3 monthly
# ==============================================================================

set -euo pipefail

IS_PRE_DEPLOY="${1:-}"
DATE_STR=$(date +"%Y-%m-%d_%H%M%S")
DAY_OF_WEEK=$(date +"%u") # 1 = Monday, 7 = Sunday
DAY_OF_MONTH=$(date +"%d")
TMP_DIR="/tmp/pg_backups"

mkdir -p "$TMP_DIR"

TENANT="${TENANT_NAME:-teacher-default}"
DEST="${BACKUP_STORAGE_DEST:-r2:teacher-backups}/${TENANT}"
PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="HTML" \
      -d text="${msg}" > /dev/null || true
  fi
}

on_failure() {
  local exit_code=$?
  echo "[BACKUP ERROR] Backup failed with exit code $exit_code."
  if [ -n "$HEALTHCHECK_URL" ]; then
    curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}/fail" > /dev/null 2>&1 || true
  fi
  send_telegram "🚨 <b>BACKUP FAILED:</b> Database backup for <code>${TENANT}</code> failed! Check logs."
  rm -f "${RAW_FILE:-}" "${ENC_FILE:-}"
  exit "$exit_code"
}
trap on_failure ERR

if [ -n "$HEALTHCHECK_URL" ] && [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
  curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL}/start" > /dev/null 2>&1 || true
fi

if [ "$IS_PRE_DEPLOY" == "--pre-deploy" ]; then
  BACKUP_TYPE="pre-deploy"
  TARGET_PATH="${DEST}/pre-deploy"
else
  BACKUP_TYPE="daily"
  TARGET_PATH="${DEST}/daily"
fi

FILENAME="${TENANT}_${BACKUP_TYPE}_${DATE_STR}.sql.gz"
RAW_FILE="${TMP_DIR}/${FILENAME}"
ENC_FILE="${TMP_DIR}/${FILENAME}.gpg"

echo "[BACKUP] Starting ${BACKUP_TYPE} dump for database: ${PGDATABASE:-elearning}..."

PGPASSWORD="${PGPASSWORD}" pg_dump \
  -h "${PGHOST:-postgres}" \
  -U "${PGUSER:-postgres}" \
  -d "${PGDATABASE:-elearning}" \
  --no-owner \
  --no-acl \
  | gzip -9 > "$RAW_FILE"

FILE_SIZE=$(du -h "$RAW_FILE" | cut -f1)
echo "[BACKUP] Dump completed. Compressed size: $FILE_SIZE"

if [ -n "$PASSPHRASE" ]; then
  echo "[BACKUP] Encrypting dump with GPG AES256..."
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$PASSPHRASE" -o "$ENC_FILE" "$RAW_FILE"
  UPLOAD_SRC="$ENC_FILE"
else
  echo "[WARN] BACKUP_ENCRYPTION_PASSPHRASE not set. Uploading unencrypted dump."
  UPLOAD_SRC="$RAW_FILE"
fi

DEST_FILENAME=$(basename "$UPLOAD_SRC")
REMOTE_NAME="${DEST%%:*}"
UPLOADED_REMOTE=0
SAVED_LOCAL=0

if [ "$IS_PRE_DEPLOY" == "--pre-deploy" ]; then
  mkdir -p /backups/pre-deploy
  cp "$UPLOAD_SRC" "/backups/pre-deploy/${DEST_FILENAME}"
  # Keep 3 days of local pre-deploy snapshots
  find /backups/pre-deploy -type f -mtime +3 -delete 2>/dev/null || true
  SAVED_LOCAL=1
  echo "[BACKUP] Local pre-deploy snapshot saved to /backups/pre-deploy/${DEST_FILENAME}"
fi

echo "[BACKUP] Uploading to object storage: ${TARGET_PATH}/${DEST_FILENAME}..."
if command -v rclone &> /dev/null && rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:"; then
  rclone copy "$UPLOAD_SRC" "$TARGET_PATH"

  # Verify remote object actually landed before reporting success
  if [ "$(rclone lsf "${TARGET_PATH}/${DEST_FILENAME}" 2>/dev/null | head -n 1)" != "$DEST_FILENAME" ]; then
    echo "[FATAL] Remote verification failed: ${TARGET_PATH}/${DEST_FILENAME} not found on ${REMOTE_NAME}!"
    exit 1
  fi
  UPLOADED_REMOTE=1

  # Weekly retention (copy Sunday daily backups to weekly folder)
  if [ "$DAY_OF_WEEK" -eq 7 ] && [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
    echo "[BACKUP] Archiving Sunday weekly copy..."
    rclone copy "$UPLOAD_SRC" "${DEST}/weekly"
  fi

  # Monthly retention (copy 1st of month backups to monthly folder)
  if [ "$DAY_OF_MONTH" -eq "01" ] && [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
    echo "[BACKUP] Archiving 1st of month copy..."
    rclone copy "$UPLOAD_SRC" "${DEST}/monthly"
  fi

  # Apply retention policies via rclone
  rclone delete --min-age 7d "${DEST}/daily" 2>/dev/null || true
  rclone delete --min-age 28d "${DEST}/weekly" 2>/dev/null || true
  rclone delete --min-age 90d "${DEST}/monthly" 2>/dev/null || true
  rclone delete --min-age 3d "${DEST}/pre-deploy" 2>/dev/null || true
elif [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
  echo "[FATAL] rclone or configured remote '${REMOTE_NAME}:' is unavailable; refusing to fake daily backup success."
  exit 1
else
  echo "[WARN] rclone remote '${REMOTE_NAME}:' not configured yet; relying on verified local pre-deploy snapshot."
fi

if [ "$UPLOADED_REMOTE" -ne 1 ] && [ "$SAVED_LOCAL" -ne 1 ]; then
  echo "[FATAL] Neither remote upload nor local pre-deploy snapshot succeeded."
  exit 1
fi

# Cleanup local temp files
rm -f "$RAW_FILE" "$ENC_FILE"

# Record Prometheus metric for node-exporter textfile collector (only after verified remote upload)
if [ "$UPLOADED_REMOTE" -eq 1 ] && [ -d /var/log/backup ]; then
  echo "backup_last_success_timestamp_seconds $(date +%s)" > /var/log/backup/backup.prom 2>/dev/null || true
fi

echo "[BACKUP] Finished successfully for ${TENANT} (${FILE_SIZE})."
if [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
  if [ -n "$HEALTHCHECK_URL" ]; then
    curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" > /dev/null 2>&1 || true
  fi
  send_telegram "💾 <b>BACKUP SUCCESS:</b> Database dump for <code>${TENANT}</code> (${FILE_SIZE}) verified on ${REMOTE_NAME}."
fi
