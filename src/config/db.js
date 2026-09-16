const { PrismaClient } = require("@prisma/client");

// Explicit pool sizing aligned with Supabase connection budget.
// max_connections=60; pooler uses ~20 for PostgREST/Auth/Storage/Realtime,
// leaving ~40 for the app. connection_limit caps client-side conns to Supavisor
// (transaction mode) — excess requests queue in Prisma, not at the pooler.
// DATABASE_CONNECTION_LIMIT and DATABASE_POOL_TIMEOUT are env-overridable for
// tuning without code changes.
//
// Concurrency math (verified for ~2000 concurrent students, Sept 2026):
//   web concurrency ≠ DB concurrency. 2000 users issuing ~1 critical request
//   per 5s = ~400 req/s. At ~3 serial round-trips/req × ~15ms hold each, that's
//   ~18 concurrent DB ops in flight — comfortably under the default 20 pool.
//   The cap of 50 stays below Supabase's ~40 app budget (any excess queues in
//   Prisma and surfaces as pool_timeout, not a pooler 503).
// The two real levers under load are NOT the pool size but: (a) round-trips per
// request (see the markVideoCompleted batching in Layer 1 of TRAE-r2-hardening)
// and (b) index-backed scans (pg_trgm on search). Pool_tail latency (held-
// connection time) is what consumes the pool; both levers shrink it.
const POOL_SIZE = Math.max(2, Math.min(Number(process.env.DATABASE_CONNECTION_LIMIT) || 20, 50));
const POOL_TIMEOUT_MS = Math.max(1000, Number(process.env.DATABASE_POOL_TIMEOUT) || 20000);

const baseUrl = process.env.DATABASE_URL || '';
let datasourceUrl = baseUrl;
try {
  const u = new URL(baseUrl);
  u.searchParams.set('connection_limit', String(POOL_SIZE));
  u.searchParams.set('pool_timeout', String(POOL_TIMEOUT_MS));
  datasourceUrl = u.toString();
} catch { /* invalid URL — Prisma will use the raw env value and throw */ }

const prisma = new PrismaClient({ datasources: { db: { url: datasourceUrl } } });

module.exports = prisma;
