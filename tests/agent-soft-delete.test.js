'use strict';

/**
 * Phase 8 — soft delete for students and courses (decision #19 + Q5).
 *
 * PURE suite: no database, no Redis, no network. Everything here runs against a
 * stub Prisma, so it pins the DECISIONS (what is written, what is refused, what the
 * purge would destroy) without depending on a migration having been applied.
 * The DB-backed half lives in tests/soft-delete-db.test.js.
 *
 * The two things worth reading first:
 *   - the happy path of delete_user asserts the exact UPDATE payload, because the
 *     whole recoverability promise is "we moved the identifiers and touched nothing
 *     else" — a stray deleteMany in there is the failure this test exists for;
 *   - the purge tests inject `cleanupRemote`, so "did it call Bunny" is asserted
 *     rather than inferred.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOFT_DELETE_RETENTION_DAYS,
  TOMBSTONE_DOMAIN,
  LIVE_ROW,
  softDeleteTombstoneEmail,
  isTombstoneEmail,
} = require('../src/services/softDelete');
const { execute } = require('../src/services/agent/tools/_kit');
const { getDefinition } = require('../src/services/agent/tools');
const { pruneSoftDeleted } = require('../src/jobs/pruneSoftDeleted');

const ADMIN_ID = 1;
const SLUG = 'a1b2c3d4e5f6';

/** Minimal ctx for a non-confirmable / confirmable call. */
const ctx = (prisma) => ({ prisma, adminId: ADMIN_ID });

/** Captures every write a stub Prisma is asked to make. */
function writeProbe(overrides = {}) {
  const calls = { updates: [], deletes: [], transactions: 0 };
  const merge = (base, extra) => ({ ...base, ...extra });
  // Built WITHOUT a top-level `...overrides` spread: that would replace the whole
  // user/course object with the override and silently drop the write probes, which
  // is the one thing this stub exists to provide.
  return {
    calls,
    user: merge(
      {
        findUnique: async () => null,
        findFirst: async () => null,
        update: async (args) => {
          calls.updates.push(args);
          return {};
        },
        delete: async () => {
          calls.deletes.push('user');
          return {};
        },
        count: async () => 0,
        findMany: async () => [],
      },
      overrides.user
    ),
    course: merge(
      {
        findUnique: async () => null,
        findFirst: async () => null,
        update: async (args) => {
          calls.updates.push(args);
          return {};
        },
        delete: async () => {
          calls.deletes.push('course');
          return {};
        },
        count: async () => 0,
        findMany: async () => [],
      },
      overrides.course
    ),
    enrollment: merge({ findMany: async () => [], count: async () => 0 }, overrides.enrollment),
    payment: merge({ count: async () => 0 }, overrides.payment),
    $transaction: async (arg) => {
      calls.transactions += 1;
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg({});
    },
  };
}

/**
 * The two confirmable deletes expose `run` on their definition, so these tests
 * call it directly: the preview/confirm TOKEN flow is already pinned in
 * tests/agent-actions-crud.test.js, and what this file is about is the write the
 * confirmed call finally performs.
 */
const runDeleteUser = (args, prisma) => getDefinition('delete_user').run(args, ctx(prisma));
const runDeleteCourse = (args, prisma) => getDefinition('delete_course').run(args, ctx(prisma));

// ─────────────────────────────────────────────────────────────────────────────
// The contract module — one definition of the window and the tombstone
// ─────────────────────────────────────────────────────────────────────────────

test.describe('softDelete — the one definition of the contract', () => {
  test.it('the window is 30 days and the filter predicate is a single exported value', () => {
    assert.equal(SOFT_DELETE_RETENTION_DAYS, 30, 'the delete confirmation promises this exact number');
    assert.deepEqual(LIVE_ROW, { deletedAt: null });
  });

  test.it('builds a tombstone that cannot collide with a real address', () => {
    assert.equal(softDeleteTombstoneEmail(SLUG), `deleted+${SLUG}@${TOMBSTONE_DOMAIN}`);
    // RFC 2606 reserves .invalid, so it can never resolve and never be registered.
    assert.equal(TOMBSTONE_DOMAIN, 'deleted.invalid');
  });

  test.it('tombstones are unique per user, because slug already is', () => {
    const a = softDeleteTombstoneEmail('aaaaaaaaaaaa');
    const b = softDeleteTombstoneEmail('bbbbbbbbbbbb');
    assert.notEqual(a, b);
    assert.equal(softDeleteTombstoneEmail('aaaaaaaaaaaa'), a, 'deterministic for one user');
  });

  test.it('recognises its own tombstones and nothing else', () => {
    assert.equal(isTombstoneEmail(softDeleteTombstoneEmail(SLUG)), true);
    assert.equal(isTombstoneEmail('student@example.com'), false);
    assert.equal(isTombstoneEmail(null), false);
    assert.equal(isTombstoneEmail(undefined), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete_user — the write, not the token flow
// ─────────────────────────────────────────────────────────────────────────────

test.describe('delete_user — a soft delete, losslessly', () => {
  const student = {
    id: 9,
    slug: SLUG,
    name: 'طالب',
    role: 'STUDENT',
    email: 'student@example.com',
    phoneNumber: '01000000000',
    deletedAt: null,
  };

  test.it('moves the identifiers aside and deletes NOTHING', async () => {
    const prisma = writeProbe({ user: { findUnique: async () => student } });
    const result = await runDeleteUser({ userSlug: SLUG }, prisma);

    assert.equal(result.ok, true);
    assert.equal(prisma.calls.updates.length, 1, 'exactly one write, and it is an update');
    assert.equal(prisma.calls.deletes.length, 0, 'a soft delete must never delete a row');
    assert.equal(prisma.calls.transactions, 0, 'no cascade transaction is involved');

    const { data } = prisma.calls.updates[0];
    // The originals are parked so a restore inside the window is lossless...
    assert.equal(data.deletedEmail, 'student@example.com');
    assert.equal(data.deletedPhoneNumber, '01000000000');
    // ...the live columns are freed...
    assert.equal(data.email, `deleted+${SLUG}@deleted.invalid`);
    assert.equal(data.phoneNumber, null);
    // ...the session is killed...
    assert.equal(data.refreshToken, null);
    assert.equal(data.refreshTokenFamily, null);
    // ...and the row is stamped.
    assert.ok(data.deletedAt instanceof Date, 'deletedAt is set from the node clock');
  });

  test.it('reports the retention window it is actually giving the admin', async () => {
    const prisma = writeProbe({ user: { findUnique: async () => student } });
    const result = await runDeleteUser({ userSlug: SLUG }, prisma);
    assert.equal(result.retentionDays, SOFT_DELETE_RETENTION_DAYS);
  });

  test.it('refuses to touch a row that is already deleted', async () => {
    const prisma = writeProbe({
      user: { findUnique: async () => ({ ...student, deletedAt: new Date('2026-09-01T00:00:00Z') }) },
    });
    const result = await runDeleteUser({ userSlug: SLUG }, prisma);
    assert.equal(result.reason, 'ALREADY_DELETED');
    assert.equal(prisma.calls.updates.length, 0, 'a refused re-delete writes nothing');
  });

  test.it('refuses an admin account, even a different one', async () => {
    const prisma = writeProbe({
      user: { findUnique: async () => ({ ...student, id: 8, role: 'ADMIN' }) },
    });
    const result = await runDeleteUser({ userSlug: SLUG }, prisma);
    assert.equal(result.reason, 'CANNOT_DELETE_ADMIN');
    assert.equal(prisma.calls.updates.length, 0);
  });

  test.it('refuses the calling admin and an unknown slug', async () => {
    const self = await runDeleteUser(
      { userSlug: SLUG },
      writeProbe({ user: { findUnique: async () => ({ ...student, id: ADMIN_ID, role: 'STUDENT' }) } })
    );
    assert.equal(self.reason, 'CANNOT_DELETE_SELF');

    const missing = await runDeleteUser({ userSlug: SLUG }, writeProbe());
    assert.equal(missing.reason, 'USER_NOT_FOUND');
  });
});



// ─────────────────────────────────────────────────────────────────────────────
// delete_course — the write, not the token flow
// ─────────────────────────────────────────────────────────────────────────────

test.describe('delete_course — hides, never destroys, never touches Bunny', () => {
  test.it('stamps deletedAt and leaves the content on Bunny alone', async () => {
    const prisma = writeProbe({
      course: {
        findUnique: async () => ({ id: 3, title: 'دورة', deletedAt: null, _count: { enrollments: 4 } }),
      },
      enrollment: { findMany: async () => [] },
    });
    const result = await runDeleteCourse({ courseSlug: SLUG }, prisma);

    assert.equal(result.ok, true);
    assert.equal(prisma.calls.updates.length, 1);
    assert.ok(prisma.calls.updates[0].data.deletedAt instanceof Date);
    assert.equal(prisma.calls.transactions, 0, 'the old hard delete ran a transaction; this one must not');
    assert.equal(prisma.calls.deletes.length, 0);
    assert.equal(result.course.hiddenEnrollments, 4, 'the admin is told how many lose access');
    assert.equal(result.retentionDays, SOFT_DELETE_RETENTION_DAYS);

  });

  test.it('refuses a course that is already deleted', async () => {
    const prisma = writeProbe({
      course: {
        findUnique: async () => ({
          id: 3,
          title: 'دورة',
          deletedAt: new Date('2026-09-01T00:00:00Z'),
          _count: { enrollments: 0 },
        }),
      },
    });
    const result = await runDeleteCourse({ courseSlug: SLUG }, prisma);
    assert.equal(result.reason, 'ALREADY_DELETED');
    assert.equal(prisma.calls.updates.length, 0);
  });
});


test.describe('pruneSoftDeleted — the 30-day hard delete', () => {
  test.it('is DISARMED by default: dry-run counts and deletes nothing', async () => {
    const db = purgeStub({ users: [{ id: 1, slug: SLUG }], courses: [{ id: 2, slug: SLUG }] });
    const result = await pruneSoftDeleted({ prisma: db, retentionDays: 30, now: NOW, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.usersDeleted, 1, 'it reports what it WOULD remove');
    assert.equal(result.coursesDeleted, 1);
    assert.deepEqual(db.seen.deletes, [], 'a dry run must not delete a single row');
  });

  test.it('scopes the query to rows older than the window, computed from the injected clock', async () => {
    const db = purgeStub();
    await pruneSoftDeleted({ prisma: db, retentionDays: 30, now: NOW, dryRun: true });

    assert.deepEqual(db.seen.userWhere, { deletedAt: { lt: new Date('2026-09-01T00:00:00Z') } });
    assert.deepEqual(db.seen.courseWhere, { deletedAt: { lt: new Date('2026-09-01T00:00:00Z') } });
  });

  test.it('caps one tick, so a backlog drains instead of locking a table', async () => {
    const db = purgeStub();
    await pruneSoftDeleted({ prisma: db, retentionDays: 30, now: NOW, dryRun: true });
    assert.equal(db.seen.userTake, 50);
    assert.equal(db.seen.courseTake, 50);
  });

  test.it('deletes children before the row when armed', async () => {
    const db = purgeStub({ users: [{ id: 1, slug: SLUG }], courses: [{ id: 2, slug: SLUG }] });
    const result = await pruneSoftDeleted({
      prisma: db,
      retentionDays: 30,
      now: NOW,
      dryRun: false,
      cleanupRemote: { deleteBunnyVideo: async () => {}, removeQuizImages: async () => {} },
    });

    assert.equal(result.usersDeleted, 1);
    assert.equal(result.coursesDeleted, 1);
    assert.ok(db.seen.deletes.includes('child'), 'children first — the FK requires it');
    assert.ok(db.seen.deletes.includes('row'), 'and then the row itself');
  });

  test.it('RETAINS payment rows and nulls their link (D1, owner ruling)', async () => {
    const db = purgeStub({
      users: [{ id: 1, slug: SLUG }],
      courses: [{ id: 2, slug: SLUG }],
      payments: { 1: 3, 2: 7 },
    });
    const result = await pruneSoftDeleted({ prisma: db, retentionDays: 30, now: NOW, dryRun: false });

    // The student and course GO...
    assert.equal(result.usersDeleted, 1);
    assert.equal(result.coursesDeleted, 1);
    // ...and their money stays.
    assert.equal(result.paymentsRetained, 10, '3 + 7 financial rows are deliberately kept');
    assert.ok(db.seen.updates.includes('payment-set-null'), 'the FK is nulled, not the row deleted');
    assert.ok(
      !db.seen.deletes.includes('payment-row'),
      'D1: a financial record must NEVER be deleted by this sweep'
    );
  });

  test.it('counts what it would retain, without retaining it, on a dry run', async () => {
    const db = purgeStub({ users: [{ id: 1, slug: SLUG }], payments: { 1: 4 } });
    const result = await pruneSoftDeleted({ prisma: db, retentionDays: 30, now: NOW, dryRun: true });
    assert.equal(result.paymentsRetained, 4, 'a dry run reports the retention it would perform');
    assert.deepEqual(db.seen.updates, [], 'and writes nothing');
  });

  test.it('is disabled — and touches nothing — when the window is not positive', async () => {
    const db = purgeStub({ users: [{ id: 1, slug: SLUG }] });
    const result = await pruneSoftDeleted({ prisma: db, retentionDays: 0, now: NOW, dryRun: false });
    assert.equal(result.disabled, true);
    assert.equal(result.usersDeleted, 0);
    assert.equal(db.seen.userWhere, null, 'no query runs at all');
  });

  test.it('runs the Bunny + storage cleanup the delete path gave up', async () => {
    const db = purgeStub({ courses: [{ id: 2, slug: SLUG }] });
    db.bunnyVideo.findMany = async () => [{ bunnyVideoId: 'guid-1' }];
    db.quiz.findMany = async () => [{ surveyJson: { pages: [] } }];
    const seen = { bunny: 0, storage: 0 };
    await pruneSoftDeleted({
      prisma: db,
      retentionDays: 30,
      now: NOW,
      dryRun: false,
      cleanupRemote: {
        deleteBunnyVideo: async () => {
          seen.bunny += 1;
        },
        removeQuizImages: async () => {
          seen.storage += 1;
        },
      },
    });
    // Without this the soft-deleted course's videos would leak on Bunny forever and
    // the admin would keep paying for content they deleted.
    assert.equal(seen.bunny, 1, 'the purge, not the delete, now owns remote cleanup');
    assert.equal(seen.storage, 1);
  });
});



// ─────────────────────────────────────────────────────────────────────────────
// The purge job — the only thing in Phase 8 that destroys data
// ─────────────────────────────────────────────────────────────────────────────

/** Stub Prisma for the sweep: records every query filter and every delete. */
function purgeStub({ users = [], courses = [], payments = {} } = {}) {
  const seen = { userWhere: null, courseWhere: null, userTake: null, courseTake: null, deletes: [], updates: [] };
  const del = () => async () => {
    seen.deletes.push('child');
    return { count: 1 };
  };
  const child = {
    deleteMany: del(),
    delete: async () => {
      seen.deletes.push('row');
      return {};
    },
  };
  return {
    seen,
    user: {
      findMany: async (args) => {
        seen.userWhere = args.where;
        seen.userTake = args.take;
        return users;
      },
      ...child,
    },
    course: {
      findMany: async (args) => {
        seen.courseWhere = args.where;
        seen.courseTake = args.take;
        return courses;
      },
      ...child,
    },
    // Payment is NOT `child`: D1 requires the sweep to UPDATE it (null the FK) and
    // never DELETE it, so the stub has to be able to tell those two apart.
    payment: {
      count: async ({ where }) => payments[where.userId] ?? payments[where.courseId] ?? 0,
      updateMany: async () => {
        seen.updates.push('payment-set-null');
        return { count: 1 };
      },
      deleteMany: async () => {
        seen.deletes.push('payment-row');
        return { count: 1 };
      },
    },
    quizAttempt: child,
    gateExemption: child,
    assignmentAnswer: child,
    submission: child,
    bunnyVideoProgress: child,
    enrollment: child,
    certificate: child,
    video: child,
    bunnyVideo: { findMany: async () => [] },
    quiz: { findMany: async () => [] },
    learningPath: { findMany: async () => [] },
    // The transaction hands a `tx` client to the callback — it must expose the same
    // child models, exactly like Prisma's, or the course delete throws inside the
    // callback and the job's try/catch swallows it into a zero count (which is a
    // silent pass for the wrong reason).
    $transaction: async (arg) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : arg({ video: child, enrollment: child, certificate: child, course: child, user: child, learningPath: { findMany: async () => [], update: async () => ({}) } }),
  };
}

const NOW = new Date('2026-10-01T00:00:00Z');
