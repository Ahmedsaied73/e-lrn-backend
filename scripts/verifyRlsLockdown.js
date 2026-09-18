// scripts/verifyRlsLockdown.js — exits 1 on any violation.
'use strict';
const prisma = require('../src/config/db');
(async () => {
  const rows = await prisma.$queryRaw`
    SELECT c.relname AS table, c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`;
  const grants = await prisma.$queryRaw`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')`;
  const noRls = rows.filter((r) => !r.rls);
  console.log(`tables: ${rows.length}, RLS-enabled: ${rows.length - noRls.length}, anon/auth grants: ${grants.length}`);
  if (noRls.length || grants.length) {
    console.error('FAIL — tables without RLS:', noRls.map((r) => r.table), 'grants:', grants);
    process.exit(1);
  }
  console.log('OK — RLS enabled on all public tables, zero anon/authenticated grants.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
