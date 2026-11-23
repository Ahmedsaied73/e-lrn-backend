#!/usr/bin/env bash
# ==============================================================================
# ZERO-DOWNTIME HEALTH-GATED DEPLOY SCRIPT — أكاديمية التميز
# ==============================================================================
# Usage:
#   bash deploy.sh --tag <GIT_SHA> [--preset 3000|4000|6000|8000|10000]
# ==============================================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/teacher-app}"
IMAGE_TAG="${1:-latest}"
PRESET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --preset)
      PRESET="$2"
      shift 2
      ;;
    *)
      if [ -z "$IMAGE_TAG" ] || [ "$IMAGE_TAG" == "latest" ]; then
        IMAGE_TAG="$1"
      fi
      shift
      ;;
  esac
done

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "[FATAL] Configuration file .env missing at $APP_DIR/.env"
  exit 1
fi

source .env

# Source preset if provided
if [ -n "$PRESET" ] && [ -f "deploy/presets/${PRESET}.env" ]; then
  echo "[INFO] Applying preset: deploy/presets/${PRESET}.env"
  source "deploy/presets/${PRESET}.env"
fi

export APP_IMAGE="${APP_IMAGE_BASE:-ghcr.io/osamasaeed/e-learning-platform}:${IMAGE_TAG}"

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="HTML" \
      -d text="${msg}" > /dev/null || true
  fi
}

echo "=== [1/6] Pre-deploy database backup ==="
if [ -f deploy/scripts/backup.sh ]; then
  bash deploy/scripts/backup.sh --pre-deploy || {
    echo "[WARN] Pre-deploy backup encountered an issue. Proceeding with caution..."
  }
fi

echo "=== [2/6] Pulling new container image (${APP_IMAGE}) ==="
docker pull "$APP_IMAGE"

echo "=== [3/6] Running Prisma database migrations ==="
docker compose run --rm --no-deps api npx prisma migrate deploy || {
  echo "[FATAL] Prisma migration failed! Deployment aborted. Running container untouched."
  send_telegram "🚨 <b>DEPLOY FAILED:</b> Prisma migration failed for <code>${DOMAIN_NAME:-tenant}</code> on image tag <code>${IMAGE_TAG}</code>."
  exit 1
}

echo "=== [4/6] Starting Standby Health Gate Verification ==="
# Launch temporary standby container to verify readiness before replacing active API
STANDBY_NAME="api_standby_$(date +%s)"
docker run -d \
  --name "$STANDBY_NAME" \
  --network "$(docker compose ps -q api | xargs docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || echo 'deploy_internal')" \
  --env-file .env \
  -e APP_MODE=api \
  "$APP_IMAGE"

HEALTHY=0
echo "Polling standby container readiness probe (/readyz)..."
for i in {1..20}; do
  if docker exec "$STANDBY_NAME" wget -q -O - http://127.0.0.1:3005/readyz 2>/dev/null | grep -q '"status":"ok"'; then
    echo "[INFO] Standby container passed /readyz on attempt $i!"
    HEALTHY=1
    break
  fi
  sleep 3
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "[FATAL] Health check failed for ${APP_IMAGE}! Rolling back immediately..."
  docker stop "$STANDBY_NAME" > /dev/null 2>&1 || true
  docker rm "$STANDBY_NAME" > /dev/null 2>&1 || true
  send_telegram "❌ <b>DEPLOY FAILED & ROLLED BACK:</b> Health probe failed on <code>${DOMAIN_NAME:-tenant}</code> for tag <code>${IMAGE_TAG}</code>. Active container was NOT interrupted."
  exit 1
fi

# Clean up verified standby container
docker stop "$STANDBY_NAME" > /dev/null 2>&1 || true
docker rm "$STANDBY_NAME" > /dev/null 2>&1 || true

echo "=== [5/6] Swapping active API & Worker containers ==="
PREVIOUS_TAG=$(cat .current_tag 2>/dev/null || echo "initial")
echo "$PREVIOUS_TAG" > .previous_tag
echo "$IMAGE_TAG" > .current_tag

# Recreate API and Worker with the new image tag
docker compose up -d --no-deps api worker

# Reload Nginx upstream connections smoothly
docker compose exec -T nginx nginx -s reload || true

echo "=== [6/6] Pruning dangling images ==="
docker image prune -f

send_telegram "✅ <b>DEPLOY SUCCESSFUL:</b> <code>${DOMAIN_NAME:-tenant}</code> successfully updated to <code>${IMAGE_TAG}</code>."
echo "=== Deployment Succeeded: ${IMAGE_TAG} ==="
