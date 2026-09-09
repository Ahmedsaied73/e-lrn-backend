// Lists user tables in the configured database (DB-state sanity checker).
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRaw`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_catalog = current_database() AND table_type = 'BASE TABLE'
    ORDER BY table_name`;
  console.log(rows.map((r) => r.name || r.NAME).join('\n'));
  await prisma.$disconnect();
})().catch((e) => {
  console.error('DB check failed:', e.message);
  process.exit(1);
});
