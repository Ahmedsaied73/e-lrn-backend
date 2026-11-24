#!/usr/bin/env bash
# ==============================================================================
# DATABASE RESTORE SCRIPT — أكاديمية التميز
# ==============================================================================
# Usage:
#   bash restore.sh [PATH_TO_BACKUP_FILE_OR_R2_URL]
# ==============================================================================

set -euo pipefail

BACKUP_SOURCE="${1:-latest}"
TMP_DIR="/tmp/pg_restore"
mkdir -p "$TMP_DIR"

if [ -f .env ]; then
  # shellcheck source=/dev/null
  source .env
fi

PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"
DEST="${BACKUP_STORAGE_DEST:-r2:teacher-backups}/${TENANT_NAME:-teacher-default}"

LOCAL_FILE=""

if [ "$BACKUP_SOURCE" == "latest" ]; then
  echo "[RESTORE] Fetching latest daily backup from storage..."
  LATEST_REMOTE=$(rclone lsf "${DEST}/daily" --files-only --sort-by-time | tail -n 1)
  if [ -z "$LATEST_REMOTE" ]; then
    echo "[FATAL] No backups found in ${DEST}/daily"
    exit 1
  fi
  echo "[RESTORE] Downloading: ${DEST}/daily/${LATEST_REMOTE}"
  rclone copy "${DEST}/daily/${LATEST_REMOTE}" "$TMP_DIR"
  LOCAL_FILE="${TMP_DIR}/${LATEST_REMOTE}"
else
  LOCAL_FILE="$BACKUP_SOURCE"
fi

echo "[RESTORE] Processing backup file: $LOCAL_FILE"

# Decrypt if GPG encrypted
UNENCRYPTED_FILE="$LOCAL_FILE"
if [[ "$LOCAL_FILE" == *.gpg ]]; then
  if [ -z "$PASSPHRASE" ]; then
    echo "[FATAL] BACKUP_ENCRYPTION_PASSPHRASE is not set in environment or .env."
    echo "Restoring an encrypted backup requires the encryption passphrase from your password manager."
    exit 1
  fi
  UNENCRYPTED_FILE="${LOCAL_FILE%.gpg}"
  echo "[RESTORE] Decrypting with GPG..."
  gpg --batch --yes --decrypt --passphrase "$PASSPHRASE" -o "$UNENCRYPTED_FILE" "$LOCAL_FILE"
fi

echo "[RESTORE] Restoring database ${POSTGRES_DB:-elearning}..."
PGPASSWORD="${POSTGRES_PASSWORD}" gunzip -c "$UNENCRYPTED_FILE" | PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  -h "${PGHOST:-localhost}" \
  -p 5432 \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-elearning}"

# Cleanup
rm -rf "$TMP_DIR"
echo "[RESTORE] Database restored successfully!"
