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

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="HTML" \
      -d text="${msg}" > /dev/null || true
  fi
}

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

echo "[BACKUP] Uploading to object storage: ${TARGET_PATH}/${FILENAME}..."
if command -v rclone &> /dev/null; then
  rclone copy "$UPLOAD_SRC" "$TARGET_PATH"
  
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
  # Daily: keep 7 days
  rclone delete --min-age 7d "${DEST}/daily" 2>/dev/null || true
  # Weekly: keep 4 weeks (28 days)
  rclone delete --min-age 28d "${DEST}/weekly" 2>/dev/null || true
  # Monthly: keep 3 months (90 days)
  rclone delete --min-age 90d "${DEST}/monthly" 2>/dev/null || true
  # Pre-deploy: keep 3 days
  rclone delete --min-age 3d "${DEST}/pre-deploy" 2>/dev/null || true
fi

# Cleanup local temp files
rm -f "$RAW_FILE" "$ENC_FILE"

echo "[BACKUP] Finished successfully for ${TENANT} (${FILE_SIZE})."
if [ "$IS_PRE_DEPLOY" != "--pre-deploy" ]; then
  send_telegram "💾 <b>BACKUP SUCCESS:</b> Database dump for <code>${TENANT}</code> (${FILE_SIZE}) uploaded to storage."
fi
