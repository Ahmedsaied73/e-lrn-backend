#!/usr/bin/env bash
# ==============================================================================
# ONE-SHOT MIGRATION: SUPABASE POSTGRES -> VPS POSTGRES
# ==============================================================================
# Usage:
#   bash migrate-supabase-to-vps.sh <SUPABASE_DIRECT_OR_POOLED_URL>
# ==============================================================================

set -euo pipefail

SUPABASE_URL="${1:-}"

if [ -z "$SUPABASE_URL" ]; then
  echo "Usage: bash migrate-supabase-to-vps.sh 'postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres'"
  exit 1
fi

if [ -f .env ]; then
  source .env
fi

TMP_DUMP="/tmp/supabase_migration_$(date +%s).sql"

echo "=== [1/3] Dumping public schema from Supabase ==="
pg_dump "$SUPABASE_URL" \
  --schema=public \
  --no-owner \
  --no-acl \
  --no-privileges \
  --clean \
  --if-exists \
  > "$TMP_DUMP"

DUMP_SIZE=$(du -h "$TMP_DUMP" | cut -f1)
echo "Dump completed (${DUMP_SIZE})."

echo "=== [2/3] Restoring dump into local VPS Postgres container ==="
docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-elearning}" < "$TMP_DUMP"

echo "=== [3/3] Running Prisma migrate deploy to ensure schema alignment ==="
docker compose run --rm api npx prisma migrate deploy

rm -f "$TMP_DUMP"
echo "=== Supabase to VPS Migration Complete! ==="
