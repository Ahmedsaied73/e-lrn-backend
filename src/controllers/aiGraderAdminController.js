'use strict';

/**
 * aiGraderAdminController.js
 * Admin-only surface for the 5-state AiGradingJob table (Section 7).
 */

const prisma = require('../config/db');

const JOB_STATUSES = ['PENDING', 'RUNNING', 'DONE_APPLIED', 'SYSTEM_GRADED', 'NEEDS_REVIEW'];

function parseInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * GET /admin/ai-grading/jobs?status=NEEDS_REVIEW&reason=&applied=&page=&limit=&search=
 */
async function listAiGradingJobs(req, res) {
  try {
    const status = req.query.status || 'NEEDS_REVIEW';
    if (!JOB_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    const page = Math.max(parseInteger(req.query.page) || 1, 1);
    const take = Math.max(1, Math.min(parseInteger(req.query.limit) || 20, 100));
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();
    const reason = (req.query.reason || '').trim();

    const where = { status };
    if (reason) where.reason = reason;
    if (req.query.applied === 'true') where.applied = true;
    if (req.query.applied === 'false') where.applied = false;

    if (search) {
      where.OR = [
        { questionName: { contains: search, mode: 'insensitive' } },
        { attempt: { user: { name: { contains: search, mode: 'insensitive' } } } },
        { attempt: { user: { email: { contains: search, mode: 'insensitive' } } } },
        { attempt: { quiz: { title: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [jobs, total] = await Promise.all([
      prisma.aiGradingJob.findMany({
        skip,
        take,
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          attemptId: true,
          questionName: true,
          status: true,
          reason: true,
          tries: true,
          maxTries: true,
          confidence: true,
          applied: true,
          appliedAt: true,
          verdict: true,
          criteriaBreakdown: true,
          tokensIn: true,
          tokensOut: true,
          error: true,
          claimedAt: true,
          leaseUntil: true,
          nextRunAt: true,
          createdAt: true,
          updatedAt: true,
          attempt: {
            select: {
              id: true,
              status: true,
              attemptNumber: true,
              submittedAt: true,
              user: { select: { id: true, name: true, email: true, grade: true } },
              quiz: {
                select: {
                  id: true,
                  title: true,
                  bunnyVideo: {
                    select: {
                      id: true,
                      title: true,
                      course: { select: { id: true, title: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.aiGradingJob.count({ where }),
    ]);

    const data = jobs.map((job) => ({
      id: job.id,
      attemptId: job.attemptId,
      questionName: job.questionName,
      status: job.status,
      reason: job.reason,
      tries: job.tries,
      maxTries: job.maxTries,
      confidence: job.confidence,
      applied: job.applied,
      appliedAt: job.appliedAt,
      verdict: job.status === 'NEEDS_REVIEW' ? job.verdict : undefined,
      criteriaBreakdown: job.criteriaBreakdown,
      tokensIn: job.tokensIn,
      tokensOut: job.tokensOut,
      error: job.error,
      claimedAt: job.claimedAt,
      leaseUntil: job.leaseUntil,
      nextRunAt: job.nextRunAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attemptStatus: job.attempt.status,
      attemptNumber: job.attempt.attemptNumber,
      submittedAt: job.attempt.submittedAt,
      student: job.attempt.user,
      quizId: job.attempt.quiz.id,
      quizTitle: job.attempt.quiz.title,
      videoId: job.attempt.quiz.bunnyVideo.id,
      videoTitle: job.attempt.quiz.bunnyVideo.title,
      courseId: job.attempt.quiz.bunnyVideo.course.id,
      courseTitle: job.attempt.quiz.bunnyVideo.course.title,
    }));

    return res.json({
      success: true,
      data,
      meta: { total, page, limit: take, totalPages: Math.ceil(total / take), status },
    });
  } catch (error) {
    console.error('[AiGraderAdmin] listAiGradingJobs error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /admin/ai-grading/retry  body: { attemptIds?: number[] }
 * Re-enqueues stuck jobs: NEEDS_REVIEW(AI_FAILED) and stale PENDING.
 */
async function retryFailedAiGrading(req, res) {
  try {
    let { attemptIds } = req.body || {};
    if (attemptIds === undefined || attemptIds === null) attemptIds = [];
    if (typeof attemptIds === 'number') attemptIds = [attemptIds];
    if (!Array.isArray(attemptIds) || attemptIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return res.status(400).json({ success: false, error: 'attemptIds must be an array of positive integers' });
    }

    const uniqueAttemptIds = attemptIds.length > 0 ? [...new Set(attemptIds)] : [];
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);

    const where = {
      OR: [
        { status: 'NEEDS_REVIEW', reason: 'AI_FAILED' },
        { status: 'PENDING', updatedAt: { lt: staleCutoff } },
      ],
    };
    if (uniqueAttemptIds.length > 0) where.attemptId = { in: uniqueAttemptIds };

    const stuckRows = await prisma.aiGradingJob.findMany({
      where,
      select: { attemptId: true },
    });
    const attempts = [...new Set(stuckRows.map((row) => row.attemptId))];

    if (attempts.length === 0) {
      return res.json({
        success: true,
        data: { attempts: 0, jobsEnqueued: 0, cleared: 0, perAttempt: [] },
      });
    }

    // Reset NEEDS_REVIEW(AI_FAILED) rows back to PENDING with tries=0 before enqueue
    await prisma.aiGradingJob.updateMany({
      where: {
        attemptId: { in: attempts },
        status: 'NEEDS_REVIEW',
        reason: 'AI_FAILED',
      },
      data: { status: 'PENDING', reason: null, tries: 0, error: null, nextRunAt: new Date() },
    });

    let enqueueAiGrading = null;
    try {
      const queueModule = require('../services/aiGrader/queue');
      enqueueAiGrading = typeof queueModule.enqueueAiGrading === 'function' ? queueModule.enqueueAiGrading : null;
    } catch {
      enqueueAiGrading = null;
    }

    let jobsEnqueued = 0;
    const perAttempt = [];
    for (const attemptId of attempts) {
      const enqueued = enqueueAiGrading
        ? await enqueueAiGrading(attemptId, { freshJobIds: true }).catch(() => 0)
        : 0;
      jobsEnqueued += enqueued;
      perAttempt.push({ attemptId, jobsEnqueued: enqueued });
    }

    return res.json({
      success: true,
      data: { attempts: attempts.length, jobsEnqueued, perAttempt },
    });
  } catch (error) {
    console.error('[AiGraderAdmin] retryFailedAiGrading error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /admin/ai-grading/health
 * Returns job counts by state, orphan count, and oldest PENDING timestamp.
 */
async function getAiGradingHealth(req, res) {
  try {
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);

    const [grouped, oldestPending, orphanRows] = await Promise.all([
      prisma.aiGradingJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.aiGradingJob.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM "QuizAttempt" qa
        WHERE qa.status = 'GRADING'
          AND qa."submittedAt" < ${staleCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM "AiGradingJob" j
            WHERE j."attemptId" = qa.id
              AND j.status IN ('PENDING', 'RUNNING', 'NEEDS_REVIEW')
          )
      `,
    ]);

    const byState = { PENDING: 0, RUNNING: 0, DONE_APPLIED: 0, SYSTEM_GRADED: 0, NEEDS_REVIEW: 0 };
    for (const row of grouped) {
      byState[row.status] = row._count._all;
    }

    return res.json({
      success: true,
      data: {
        byState,
        orphans: orphanRows[0] ? Number(orphanRows[0].count) : 0,
        oldestPending: oldestPending ? oldestPending.createdAt : null,
        queueDepth: byState.PENDING + byState.RUNNING,
      },
    });
  } catch (error) {
    console.error('[AiGraderAdmin] getAiGradingHealth error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  listAiGradingJobs,
  retryFailedAiGrading,
  getAiGradingHealth,
};
