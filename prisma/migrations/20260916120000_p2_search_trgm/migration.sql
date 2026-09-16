-- P2 search acceleration (Stage-2 DB audit, 2026-09-16, STAGING).
--
-- `GET /search` (searchController) filters Course.title / Course.description
-- and BunnyVideo.title with Prisma `contains` + `mode:'insensitive'`, which
-- compiles to a leading-wildcard ILIKE. Without trigram indexes Postgres
-- falls back to a seq scan on every search — the audit's biggest per-request
-- DB cost for a keyword query.
--
-- pg_trgm GIN indexes (gin_trgm_ops) make `%term%` ILIKE index-backed. Note
-- the pg_trgm token granularity: patterns shorter than 3 characters fall back
-- to a seq scan (correctness unchanged, just planner choice) — acceptable.
--
-- Extension + opclass are schema-qualified on purpose: Supabase stores
-- extensions in the `extensions` schema (see pgcrypto/uuid-ossp above), and
-- gin_trgm_ops must be resolvable regardless of the caller's search_path.
--
-- LIKE-collation caveat (verified Sept 2026): Prisma's `mode:'insensitive'`
-- renders `ILIKE`, which maps to LOWER() comparisons per row. Under w/ collate
-- provider is "Default" so Postgres uses C collation for byte-wise ILIKE —
-- safe, no locale surprises.
--
-- Replay-safe: plain CREATE INDEX (no CONCURRENTLY — Prisma `migrate deploy`
-- replays migration files inside a transaction where CONCURRENTLY is illegal),
-- IF NOT EXISTS for idempotency. Applied via `prisma migrate deploy`.
--
-- Rollback (run standalone, never inside a transaction):
--   DROP INDEX "Course_title_trgm_idx";
--   DROP INDEX "Course_description_trgm_idx";
--   DROP INDEX "BunnyVideo_title_trgm_idx";

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS "Course_title_trgm_idx"
  ON "Course" USING gin ("title" extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Course_description_trgm_idx"
  ON "Course" USING gin ("description" extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "BunnyVideo_title_trgm_idx"
  ON "BunnyVideo" USING gin ("title" extensions.gin_trgm_ops);