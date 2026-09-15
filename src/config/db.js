const { PrismaClient } = require("@prisma/client");

// Explicit pool sizing aligned with Supabase connection budget.
// max_connections=60; pooler uses ~20 for PostgREST/Auth/Storage/Realtime,
// leaving ~40 for the app. connection_limit caps client-side conns to Supavisor
// (transaction mode) — excess requests queue in Prisma, not at the pooler.
// DATABASE_CONNECTION_LIMIT and DATABASE_POOL_TIMEOUT are env-overridable for
// tuning without code changes.
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
