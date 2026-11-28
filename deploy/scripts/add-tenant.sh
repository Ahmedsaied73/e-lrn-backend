#!/usr/bin/env bash
# ==============================================================================
# TENANT ONBOARDING SCRIPT — أكاديمية التميز
# ==============================================================================
# Prepares a new teacher VPS: applies preset sizing, creates directory configs,
# generates template configuration, and initializes services.
# Usage:
#   sudo bash add-tenant.sh <TENANT_NAME> <DOMAIN_NAME> <PRESET: 3000|4000|6000|8000|10000>
# ==============================================================================

set -euo pipefail

TENANT_NAME="${1:-}"
DOMAIN_NAME="${2:-}"
PRESET="${3:-3000}"

if [ -z "$TENANT_NAME" ] || [ -z "$DOMAIN_NAME" ]; then
  echo "Usage: sudo bash add-tenant.sh <TENANT_SLUG> <api.teacherdomain.com> [3000|4000|6000|8000|10000]"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/teacher-app}"
if [ -d "$APP_DIR" ] && [ "$(pwd)" != "$APP_DIR" ]; then
  cd "$APP_DIR"
fi

echo "=== Onboarding Tenant: ${TENANT_NAME} on ${DOMAIN_NAME} (Preset: ${PRESET}) ==="

if [ ! -f "deploy/presets/${PRESET}.env" ]; then
  echo "[FATAL] Preset deploy/presets/${PRESET}.env does not exist."
  exit 1
fi

# Ensure SSL, backup & rclone config exist (prevents Docker creating rclone.conf as a directory)
mkdir -p deploy/nginx/ssl backups/pre-deploy /root/.config/rclone
chmod 700 deploy/nginx/ssl
if [ ! -f /root/.config/rclone/rclone.conf ]; then
  touch /root/.config/rclone/rclone.conf
  chmod 600 /root/.config/rclone/rclone.conf
fi

# 1. Prepare Nginx configuration from template
export DOMAIN_NAME
# shellcheck disable=SC2016
envsubst '${DOMAIN_NAME}' < deploy/nginx/site.conf.template > deploy/nginx/site.conf

# 2. Prepare PostgreSQL configuration from preset
# shellcheck source=/dev/null
source "deploy/presets/${PRESET}.env"
export PG_MAX_CONNECTIONS PG_SHARED_BUFFERS PG_WORK_MEM PG_MAINTENANCE_WORK_MEM PG_EFFECTIVE_CACHE_SIZE
envsubst < deploy/postgres/postgresql.conf.template > deploy/postgres/postgresql.conf

# 3. Create initial .env if not present
if [ ! -f .env ]; then
  echo "Creating .env from template..."
  cp deploy/tenants/_template.env.example .env
  
  # Inject random secure passwords
  PG_PASS=$(openssl rand -hex 24)
  REDIS_PASS=$(openssl rand -hex 24)
  JWT_SEC=$(openssl rand -hex 32)
  REFRESH_SEC=$(openssl rand -hex 32)
  METRICS_TOK=$(openssl rand -hex 24)
  BACKUP_PASS=$(openssl rand -hex 24)
  ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)!A1"

  sed -i "s/CHANGE_ME_SECURE_PG_PASSWORD_32_CHARS/${PG_PASS}/g" .env
  sed -i "s/CHANGE_ME_SECURE_REDIS_PASSWORD_32_CHARS/${REDIS_PASS}/g" .env
  sed -i "s/CHANGE_ME_RANDOM_HEX_64_CHARACTERS/${JWT_SEC}/g" .env
  sed -i "s/CHANGE_ME_DIFFERENT_RANDOM_HEX_64_CHARACTERS/${REFRESH_SEC}/g" .env
  sed -i "s/CHANGE_ME_RANDOM_METRICS_BEARER_TOKEN/${METRICS_TOK}/g" .env
  sed -i "s/CHANGE_ME_SECURE_PASSPHRASE_FOR_GPG/${BACKUP_PASS}/g" .env
  sed -i "s/CHANGE_ME_INITIAL_STRONG_ADMIN_PASSWORD/${ADMIN_PASS}/g" .env
  sed -i "s/teacher-slug-name/${TENANT_NAME}/g" .env
  sed -i "s/api.teacherdomain.com/${DOMAIN_NAME}/g" .env

  chmod 600 .env
  chown deploy:deploy .env
  echo "Generated unique secrets and initial admin password in .env."
  echo "Initial Admin Password (save this now): ${ADMIN_PASS}"
fi

# Read the generated or existing backup passphrase
PASSPHRASE_VAL=$(grep '^BACKUP_ENCRYPTION_PASSPHRASE=' .env | cut -d '=' -f2- || true)

echo "==================================================================="
echo "TENANT INITIALIZED!"
echo "Next steps:"
echo "1. Place Cloudflare Origin CA certificates in:"
echo "   - ${APP_DIR}/deploy/nginx/ssl/origin.pem"
echo "   - ${APP_DIR}/deploy/nginx/ssl/origin.key"
echo "2. Edit ${APP_DIR}/.env to configure Bunny, Gemini, Paymob, Supabase Storage, and R2 keys."
echo "3. Run: docker compose -f deploy/docker-compose.yml --env-file .env up -d"
echo "==================================================================="
echo ""
echo "==================================================================="
echo "⚠️  CRITICAL: BACKUP ENCRYPTION PASSPHRASE MUST BE STORED SECURELY ⚠️"
echo "==================================================================="
echo "BACKUP_ENCRYPTION_PASSPHRASE: ${PASSPHRASE_VAL}"
echo ""
echo "YOU MUST SAVE THIS PASSPHRASE AND YOUR RCLONE CREDENTIALS IN A SECURE"
echo "PASSWORD MANAGER (e.g. 1Password / Bitwarden / KeePass) OUTSIDE THIS SERVER."
echo "If this server is destroyed, backups CANNOT be decrypted without it!"
echo "==================================================================="
read -r -p "Have you securely saved BACKUP_ENCRYPTION_PASSPHRASE outside the server? (yes/no): " CONFIRM_SAVED
if [ "$CONFIRM_SAVED" != "yes" ]; then
  echo "[WARNING] Please save BACKUP_ENCRYPTION_PASSPHRASE in your password manager immediately!"
else
  echo "[OK] Passphrase confirmed saved."
fi
echo "==================================================================="
