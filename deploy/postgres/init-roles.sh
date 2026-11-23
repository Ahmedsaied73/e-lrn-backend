#!/bin/bash
set -e

# Run with scram-sha-256 password encryption
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Enable required extensions
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";

    -- Performance and security defaults
    ALTER SYSTEM SET password_encryption = 'scram-sha-256';
EOSQL

echo "[INIT] PostgreSQL extensions and scram-sha-256 enabled."
