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

APP_DIR="/opt/teacher-app"

echo "=== Onboarding Tenant: ${TENANT_NAME} on ${DOMAIN_NAME} (Preset: ${PRESET}) ==="

if [ ! -f "deploy/presets/${PRESET}.env" ]; then
  echo "[FATAL] Preset deploy/presets/${PRESET}.env does not exist."
  exit 1
fi

# 1. Prepare Nginx configuration from template
export DOMAIN_NAME
envsubst '${DOMAIN_NAME}' < deploy/nginx/site.conf.template > deploy/nginx/site.conf

# 2. Prepare PostgreSQL configuration from preset
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

  sed -i "s/CHANGE_ME_SECURE_PG_PASSWORD_32_CHARS/${PG_PASS}/g" .env
  sed -i "s/CHANGE_ME_SECURE_REDIS_PASSWORD_32_CHARS/${REDIS_PASS}/g" .env
  sed -i "s/CHANGE_ME_RANDOM_HEX_64_CHARACTERS/${JWT_SEC}/g" .env
  sed -i "s/CHANGE_ME_DIFFERENT_RANDOM_HEX_64_CHARACTERS/${REFRESH_SEC}/g" .env
  sed -i "s/CHANGE_ME_RANDOM_METRICS_BEARER_TOKEN/${METRICS_TOK}/g" .env
  sed -i "s/CHANGE_ME_SECURE_PASSPHRASE_FOR_GPG/${BACKUP_PASS}/g" .env
  sed -i "s/teacher-slug-name/${TENANT_NAME}/g" .env
  sed -i "s/api.teacherdomain.com/${DOMAIN_NAME}/g" .env

  chmod 600 .env
  chown deploy:deploy .env
  echo "Generated unique secrets in .env."
fi

echo "==================================================================="
echo "TENANT INITIALIZED!"
echo "Next steps:"
echo "1. Place Cloudflare Origin CA certificates in:"
echo "   - /etc/ssl/cloudflare/origin.pem"
echo "   - /etc/ssl/cloudflare/origin.key"
echo "2. Edit /opt/teacher-app/.env to configure Bunny, Gemini, and Telegram keys."
echo "3. Run: docker compose up -d"
echo "==================================================================="
