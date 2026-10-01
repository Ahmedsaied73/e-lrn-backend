'use strict';

/**
 * pruneSoftDeleted.js — the 30-day hard-delete sweep for soft-deleted users and
 * courses (Phase 8 §8.5).
 *
 * Cloned from pruneAgentMemories.js deliberately: same cron shape, same
 * process-local + distributed lock, same fail-open policy, same select-then-delete
 * (Postgres has no `DELETE ... LIMIT`) and the same batch cap. A reader who knows
 * one job in this service knows all of them, and a Redis outage degrades every job
 * the same way instead of each one inventing its own answer.
 *
 * TWO THINGS THIS JOB OWNS THAT THE DELETE PATH DELIBERATELY GAVE UP:
 *
 *  1. The REMOTE cleanup. `delete_course` stopped calling Bunny Stream / Supabase
 *     Storage because it no longer destroys the rows it would have to clean up
 *     after. If this job did not do it, every soft-deleted course would leak its
 *     videos on Bunny's servers forever — the admin would be billed for content
 *     they deleted. So the hard delete here runs the cleanup the old code ran.
 *
 *  2. The PAYMENT ruling (D1, owner decision). Payments are FINANCIAL RECORDS: the
 *     sweep RETAINS them and nulls their link to the student it is deleting, so the
 *     amount, currency, provider reference and transaction id outlive the account.
 *     (The alternative — skipping any user with payments — was the pre-decision
 *     default and is NOT what ships; see PHASE_8_REPORT §7 D1.) That is why
 *     `Payment.userId` is nullable (migration 20261003000000).
 *
 * Dry-run is ON by default (SOFT_DELETE_PURGE_DRY_RUN): a destructive sweep that
 * arms itself because someone forgot an env var is the failure mode this default
 * exists to prevent. It logs what it WOULD delete and touches nothing.
 */

const cron = require('node-cron');
const config = require('../config/env');
const prisma = require('../config/db');
const { acquireLock, releaseLock } = require('../integrations/redis/distributedLock');

const LOCK_KEY = 'lock:prune-soft-deleted';
const LOCK_TTL_SECONDS = 300; // 5 min — longer than any realistic run.

/** One tick's footprint per table. Small on purpose: this is a destructive sweep. */
const PURGE_BATCH = 50;

let isRunning = false;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

/**
 * Read the ops switch from the ONE resolved place (config.softDelete.purgeDryRun,
 * whose env default is TRUE). Reads the config rather than process.env directly so
 * there is no second parsing rule that could disagree with env.js about what
 * "false" means. Tests never depend on this: pruneSoftDeleted takes `dryRun` as an
 * explicit parameter, so a test can exercise both modes without touching env.
 */
function isDryRun() {
  return config.softDelete.purgeDryRun !== false;
}

/**
 * Hard-delete one course and everything that hangs off it, then its remote
 * artifacts. Mirrors the pre-Phase-8 `delete_course` body exactly — same order,
 * same best-effort remote step AFTER the commit — because that order is what made
 * the operation survivable.
 */
async function hardDeleteCourse(courseId, { prisma: db, cleanupRemote }) {
  const [bunnyVideos, quizRows] = await Promise.all([
    db.bunnyVideo.findMany({ where: { courseId }, select: { bunnyVideoId: true } }),
    db.quiz.findMany({ where: { bunnyVideo: { courseId } }, select: { surveyJson: true } }),
  ]);

  await db.$transaction(async (tx) => {
    // Children whose FK is Restrict are removed explicitly — a bare course.delete
    // throws P2003 for any course with rows.
    await tx.video.deleteMany({ where: { courseId } });
    await tx.enrollment.deleteMany({ where: { courseId } });
    await tx.certificate.deleteMany({ where: { courseId } });

    // A course inside a learning path is DISCONNECTED, never cascade-deleted — the
    // path is a separate product object that outlives the course.
    const paths = await tx.learningPath.findMany({
      where: { courses: { some: { id: courseId } } },
      select: { id: true },
    });
    for (const path of paths) {
      await tx.learningPath.update({
        where: { id: path.id },
        data: { courses: { disconnect: { id: courseId } } },
      });
    }

    await tx.course.delete({ where: { id: courseId } });
  });

  // Remote cleanup AFTER the commit, best-effort: the rows are already gone and
  // failing here would only lie to the log. Leaked Bunny objects are recoverable by
  // hand; a half-deleted database row is not.
  let remoteFailures = 0;
  for (const video of bunnyVideos) {
    try {
      await cleanupRemote.deleteBunnyVideo(video.bunnyVideoId);
    } catch (err) {
      remoteFailures += 1;
      log.error('soft_delete.purge.bunny_cleanup_failed', { bunnyVideoId: video.bunnyVideoId, error: err.message });
    }
  }
  for (const quiz of quizRows) {
    try {
      await cleanupRemote.removeQuizImages(quiz.surveyJson);
    } catch (err) {
      remoteFailures += 1;
      log.error('soft_delete.purge.storage_cleanup_failed', { error: err.message });
    }
  }

  return { bunnyVideos: bunnyVideos.length, remoteFailures };
}

/**
 * Hard-delete one user, children first. Mirrors the pre-Phase-8 `delete_user`
 * cascade list; `AuditLog.actorId` is `onDelete: SetNull`, so the audit trail
 * survives the account with a null actor — which is why AuditLog is NOT in this
 * list and must never be added to it.
 */
async function hardDeleteUser(userId, { prisma: db }) {
  await db.$transaction([
    // Phase 8 / D1 (owner ruling): PAYMENTS ARE RETAINED. The financial record
    // outlives the student, so its FK is nulled rather than the row deleted, and it
    // is deliberately FIRST so the later `user.delete` cannot trip the FK. This is
    // the one line that used to be `payment.deleteMany`.
    db.payment.updateMany({ where: { userId }, data: { userId: null } }),
    db.quizAttempt.deleteMany({ where: { userId } }),
    db.gateExemption.deleteMany({ where: { userId } }),
    db.assignmentAnswer.deleteMany({ where: { userId } }),
    db.submission.deleteMany({ where: { userId } }),
    db.bunnyVideoProgress.deleteMany({ where: { userId } }),
    db.enrollment.deleteMany({ where: { userId } }),
    db.certificate.deleteMany({ where: { userId } }),
    db.user.delete({ where: { id: userId } }),
  ]);
}

/**
 * One sweep. Exported so tests and a manual cleanup can run it without waiting for
 * the schedule. A DATABASE error is allowed to propagate to the caller (the job
 * owns logging and the fail-open policy), except per-row deletions, which are
 * counted and skipped so one bad row cannot strand the batch.
 *
 * @returns {Promise<object>} counts, plus `dryRun` so a log line can never be
 *   mistaken for a deletion that happened.
 */
async function pruneSoftDeleted({ prisma: db = prisma, retentionDays, now = new Date(), dryRun = isDryRun(), cleanupRemote } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    return { dryRun, disabled: true, usersDeleted: 0, coursesDeleted: 0, paymentsRetained: 0 };
  }
  if (!db || typeof db !== 'object') throw new Error('pruneSoftDeleted: prisma is required');

  const remote = cleanupRemote || {
    deleteBunnyVideo: async (bunnyVideoId) =>
      require('../integrations/bunny/bunnyStreamClient').deleteVideo(bunnyVideoId),
    removeQuizImages: async (surveyJson) =>
      require('../integrations/supabase/supabaseClient').removeQuizImagesBestEffort(surveyJson),
  };

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = {
    dryRun,
    disabled: false,
    usersDeleted: 0,
    coursesDeleted: 0,
    // D1 (owner ruling): the count of financial rows this sweep deliberately KEEPS.
    // Reported on every run so "we retained N payments" is visible, not silent.
    paymentsRetained: 0,
  };

  // ── Users ──────────────────────────────────────────────────────────────────
  // Oldest first, so a partial run always drains the longest-expired rows.
  const users = await db.user.findMany({
    where: { deletedAt: { lt: cutoff } },
    orderBy: { deletedAt: 'asc' },
    take: PURGE_BATCH,
    select: { id: true, slug: true },
  });

  for (const user of users) {
    // Counted BEFORE the delete because the FK is nulled in the same transaction —
    // after it, the rows are no longer findable by userId (which is the whole point
    // of D1: the payment survives, the link to the student does not).
    const retained = await db.payment.count({ where: { userId: user.id } });
    if (dryRun) {
      result.usersDeleted += 1; // "would delete"
      result.paymentsRetained += retained;
      continue;
    }
    try {
      await hardDeleteUser(user.id, { prisma: db });
      result.usersDeleted += 1;
      result.paymentsRetained += retained;
      if (retained > 0) log.info('soft_delete.purge.payments_retained', { userId: user.id, retained });
    } catch (err) {
      log.error('soft_delete.purge.user_delete_failed', { userId: user.id, error: err.message });
    }
  }

  // ── Courses ────────────────────────────────────────────────────────────────
  const courses = await db.course.findMany({
    where: { deletedAt: { lt: cutoff } },
    orderBy: { deletedAt: 'asc' },
    take: PURGE_BATCH,
    select: { id: true, slug: true },
  });

  for (const course of courses) {
    // `Payment.courseId` is already nullable, so Postgres would null it on delete
    // anyway; counting it here is what makes the retention reportable.
    const retained = await db.payment.count({ where: { courseId: course.id } });
    if (dryRun) {
      result.coursesDeleted += 1; // "would delete"
      result.paymentsRetained += retained;
      continue;
    }
    try {
      const { remoteFailures } = await hardDeleteCourse(course.id, { prisma: db, cleanupRemote: remote });
      result.coursesDeleted += 1;
      result.paymentsRetained += retained;
      if (remoteFailures > 0) {
        log.warn('soft_delete.purge.course_remote_cleanup_partial', { courseId: course.id, remoteFailures });
      }
    } catch (err) {
      log.error('soft_delete.purge.course_delete_failed', { courseId: course.id, error: err.message });
    }
  }

  return result;
}


/** One guarded sweep: process-local re-entry guard, then the distributed lock. */
async function runSweep() {
  if (isRunning) {
    log.warn('soft_delete.purge.skip_overlap');
    return { skipped: 'overlap' };
  }

  let lock;
  try {
    lock = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  } catch (err) {
    // Same commitment boundary as its siblings: a Redis hiccup must not disable the
    // sweep. The process-local guard is all we still have, and the worst case of a
    // doubled sweep is deleting rows that are already children of a deleted parent.
    log.warn('soft_delete.purge.lock_failed', { error: err.message });
    lock = { acquired: true, token: null };
  }
  if (!lock.acquired) {
    log.warn('soft_delete.purge.skip_lock_held');
    return { skipped: 'lock' };
  }

  isRunning = true;
  const dryRun = isDryRun();
  const retentionDays = config.softDelete.retentionDays;

  try {
    // Log the intent BEFORE acting. A destructive sweep whose log only appears
    // afterwards is unreadable exactly when it matters most.
    log.info('soft_delete.purge.starting', { dryRun, retentionDays });

    const result = await pruneSoftDeleted({ prisma, retentionDays, dryRun });

    if (result.usersDeleted || result.coursesDeleted || result.paymentsRetained) {
      log.info(dryRun ? 'soft_delete.purge.dry_run_result' : 'soft_delete.purge.completed', result);
    }
    return result;
  } catch (err) {
    // Retention failing must never crash the process; the window simply slips a day.
    log.error('soft_delete.purge.failed', { error: err.message });
    return { error: err.message };
  } finally {
    isRunning = false;
    try {
      await releaseLock(LOCK_KEY, lock.token);
    } catch (err) {
      log.warn('soft_delete.purge.lock_release_failed', { error: err.message });
    }
  }
}

/**
 * Start the daily sweep. 04:17 — deliberately after the conversation (03:17) and
 * memory (03:47) ticks so the three never stack on the same minute.
 */
function startSoftDeletePurgeJob() {
  const task = cron.schedule('17 4 * * *', async () => {
    // Top-level catch: an unhandled rejection here becomes an unhandledRejection in
    // the app process. runSweep already catches; this is belt and braces so a
    // future edit cannot take the server down at 04:17.
    try {
      await runSweep();
    } catch (err) {
      log.error('soft_delete.purge.unhandled_error', { error: err.message });
    }
  });

  log.info('soft_delete.purge.job_started', {
    schedule: 'daily at 04:17',
    retentionDays: config.softDelete.retentionDays,
    dryRun: isDryRun(),
  });
  return task;
}

function stopSoftDeletePurgeJob(task) {
  try {
    if (task && task.destroy) task.destroy();
  } catch (err) {
    log.warn('soft_delete.purge.job_stop_failed', { error: err.message });
  }
}

module.exports = { startSoftDeletePurgeJob, stopSoftDeletePurgeJob, pruneSoftDeleted, runSweep, isDryRun };

