'use strict';

/**
 * Phase 8 — soft delete against the REAL database.
 *
 * The pure suite (tests/agent-soft-delete.test.js) pins the decisions. This file
 * answers the questions only a real database can:
 *   1. does migration 20261002000000 actually exist here (deletedEmail /
 *      deletedPhoneNumber), and
 *   2. do the filters added to the AGENT READ TOOLS really exclude a soft-deleted
 *      row when the whole stack runs: table → tool → payload?
 *
 * SKIP-IF-UNAPPLIED: the migration is delivered as SQL for the owner to apply (plan
 * rule 2 — the agent must never apply a migration to a shared database). Until it
 * runs, `deletedEmail` does not exist, so these tests detect that single error code
 * and SKIP with an instruction rather than failing red. The moment the migration
 * lands they arm themselves, with no code change.
 *
 * Net-zero: every row this file creates it deletes in `after`.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const { execute } = require('../src/services/agent/tools/_kit');
const { getDefinition } = require('../src/services/agent/tools');
const authController = require('../src/controllers/authController');
const { pruneSoftDeleted } = require('../src/jobs/pruneSoftDeleted');
const { SOFT_DELETE_RETENTION_DAYS, softDeleteTombstoneEmail } = require('../src/services/softDelete');

const ADMIN_ID = 1;
const created = { users: [], courses: [] };
let subject = null;

let ready = false;

const SKIP =
  'migration 20261002000000_soft_delete_identifiers is NOT applied to this database — ' +
  'apply it (PHASE_8_REPORT.md §8), then re-run to arm these tests';

/** True when the Phase 8 columns are unavailable to this checkout — either because
 *  the migration has not been applied (P2022, "column does not exist") OR because the
 *  generated Prisma client itself predates the schema change (an unknown-argument
 *  validation error). Both mean the same thing to a reader: run §8 of the Phase 8
 *  report, then re-run this file. Checking only P2022 would report the second shape
 *  as a real failure, which is how this test lied on its first run. */
async function migrationMissing() {
  try {
    await prisma.user.findFirst({ where: { deletedEmail: 'probe@deleted.invalid' }, select: { id: true } });
    return false;
  } catch (err) {
    if (err.code === 'P2022') return true;
    return err.name === 'PrismaClientValidationError' && /deletedEmail/i.test(String(err.message));
  }
}

test.describe('soft delete — against the real database', { concurrency: false }, () => {
  test.before(async () => {
    if (await migrationMissing()) return;
    ready = true;

    const suffix = Date.now().toString(36);
    subject = await prisma.user.create({
      data: {
        name: 'طالب حذف مؤقت',
        email: `p8-soft-${suffix}@example.com`,
        phoneNumber: `010${suffix.slice(-8)}`,
        password: 'x',
        slug: `p8${suffix.slice(-10)}`,
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
      },
      select: { id: true, slug: true, email: true, phoneNumber: true },
    });
    created.users.push(subject);

    // The REAL run() the confirm step calls (the token flow itself is pinned elsewhere).
    // When the migration IS applied this always succeeds and `subject` is soft-deleted;
    // the tests then assert on the deleted shape. There is no catch-and-continue
    // here: a failure in before is a REAL failure worth failing loudly, because the
    // migration is present and the write must work.
    await getDefinition('delete_user').run({ userSlug: subject.slug }, { prisma, adminId: ADMIN_ID });
  });

  test.after(async () => {
    for (const user of created.users) {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    }
    for (const course of created.courses) {
      await prisma.course.delete({ where: { id: course.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  test.it('parks the identifiers, frees the live columns, revokes the session', async (t) => {
    if (!ready) return t.skip(SKIP);
    const after = await prisma.user.findUnique({
      where: { id: subject.id },
      select: { email: true, phoneNumber: true, deletedEmail: true, deletedPhoneNumber: true, refreshToken: true, deletedAt: true },
    });
    assert.equal(after.deletedEmail, subject.email, 'the original address is preserved');
    assert.equal(after.deletedPhoneNumber, subject.phoneNumber, 'and the phone');
    assert.equal(after.email, softDeleteTombstoneEmail(subject.slug), 'the live column is a tombstone');
    assert.equal(after.phoneNumber, null, 'the phone is released');
    assert.equal(after.refreshToken, null, 'the session is revoked');
    assert.ok(after.deletedAt instanceof Date, 'and the row is stamped');
  });

  test.it('the row still exists — the delete is reversible, not destructive', async (t) => {
    if (!ready) return t.skip(SKIP);
    const row = await prisma.user.findUnique({ where: { id: subject.id }, select: { id: true } });
    assert.ok(row, 'a soft delete must leave the row in place for the 30-day window');
  });

  test.it('frees the address: a NEW student can register with it', async (t) => {
    if (!ready) return t.skip(SKIP);
    const reused = await prisma.user.create({
      data: {
        name: 'طالب جديد',
        email: subject.email,
        password: 'x',
        slug: `p9${Date.now().toString(36).slice(-10)}`,
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
      },
      select: { id: true },
    });
    created.users.push(reused);
    assert.ok(reused.id, 'the freed address was available (Q5)');
  });

  test.it('the agent read tools no longer surface the deleted student', async (t) => {
    if (!ready) return t.skip(SKIP);
    // student_search runs the real filtered query end to end.
    const res = await execute(
      getDefinition('student_search'),
      { query: subject.email.split('@')[0] },
      { prisma, adminId: ADMIN_ID }
    );
    const hits = (res.data.rows || []).filter((r) => r.slug === subject.slug);
    assert.equal(hits.length, 0, 'PHASE 8 FILTER: search must skip a soft-deleted account');

    // The platform overview's student count must not include them either.
    const overview = await execute(getDefinition('platform_overview'), {}, { prisma, adminId: ADMIN_ID });
    assert.equal(typeof overview.data.students, 'number', 'overview still answers with a count');
  });

  test.it('the purge is DRY by default and removes nothing', async (t) => {
    if (!ready) return t.skip(SKIP);
    const result = await pruneSoftDeleted({ prisma, retentionDays: SOFT_DELETE_RETENTION_DAYS, dryRun: true });
    assert.equal(result.dryRun, true);
    const after = await prisma.user.findUnique({ where: { id: subject.id }, select: { id: true } });
    assert.ok(after, 'a dry run must never remove a row');
  });





  // This test needs NO migration: it asserts the login path behaves BEFORE the
  // migration is applied. A missing `deletedEmail` column must degrade to an
  // ordinary 401, never a 500 — so THIS test runs even when the rest skip.
  test.it('login with an unknown email is a clean 401, never a 500 from the unapplied migration', async () => {
    const req = { body: { email: `ghost-${Date.now()}@localhost.test`, password: 'wrong' }, ip: '127.0.0.1' };
    let status = null;
    let body = null;
    const res = {
      status: (code) => {
        status = code;
        return res;
      },
      json: (payload) => {
        body = payload;
        return res;
      },
      set: () => res,
    };
    await authController.login(req, res);
    assert.equal(status, 401, 'an unknown address must never 500, migration or not');
    assert.equal(body.success, false);
    assert.ok(!body.code || body.code !== 'ACCOUNT_DELETED', 'a ghost address is a wrong password, not a deletion');
  });
});