'use strict';

/**
 * Phase D prep — re-mint FRESH access JWTs for the existing k6 model cohort
 * WITHOUT touching users, enrollments, courses, videos, or progress rows.
 *
 * The seeded .tokens.json JWTs expired 2026-09-23 (generated 09-22 for 12h),
 * so the k6 mix now measures only 401 paths. The 10k cohort users already
 * exist in staging (createMany skipDuplicates would top them up), and
 * re-running the full seed script with a different --count fails its own
 * refetch assertion. This script only re-signs tokens:
 *   node scripts/refreshLoadTestTokens.js
 * It rewrites loadtest/.tokens.json preserving every non-auth field.
 *
 * Uses the same issuer as the seed (src/utils createToken, type:'access').
 */

process.chdir(__dirname + '/..');
const fs = require('node:fs');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TOKENS_PATH = 'loadtest/.tokens.json';

(async () => {
  const doc = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  const users = doc.users || doc.tokens;
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('.tokens.json has no users array — run the full seed once first');
  }

  const emails = new Set();
  for (const u of users) {
    const payload = JSON.parse(Buffer.from((u.jwt || u.token).split('.')[1], 'base64url').toString());
    emails.add(payload.email);
  }
  console.log(`re-minting tokens for ${emails.size} cohort users...`);

  const rows = await prisma.user.findMany({
    where: { email: { in: [...emails] } },
    select: { id: true, email: true, name: true, role: true },
  });
  const byEmail = new Map(rows.map((r) => [r.email, r]));
  const missing = [...emails].filter((e) => !byEmail.has(e));
  if (missing.length > 0) {
    throw new Error(`cohort users missing from DB: ${missing.length} (e.g. ${missing.slice(0, 3).join(', ')})`);
  }

  for (const u of users) {
    const payload = JSON.parse(Buffer.from((u.jwt || u.token).split('.')[1], 'base64url').toString());
    const row = byEmail.get(payload.email);
    // 12h expiry matches the original k6 harness convention ("pre-generate 12h
    // access tokens"): a full L0→L4 ramp plus re-runs must not expire mid-stage
    // when staging Supabase enforces nothing but signature + exp.
    u.jwt = createToken({ id: row.id, email: row.email, name: row.name, role: row.role }, config.jwt.secret, '12h');
  }
  doc.generatedAt = new Date().toISOString();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(doc), 'utf8');
  console.log(`rewrote ${TOKENS_PATH}: ${users.length} fresh tokens, generatedAt=${doc.generatedAt}`);

  const check = JSON.parse(Buffer.from(users[0].jwt.split('.')[1], 'base64url').toString());
  console.log(`sample id=${check.id} email=${check.email} type=${check.type} exp=${new Date(check.exp * 1000).toISOString()}`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('REFRESH ERROR:', e.message);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
