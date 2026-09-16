'use strict';

/**
 * aiGraderAdminController.js
 * Admin-only surface for the durable AiGradingJob audit table (J1/T4.1).
 *
 * The worker writes one AiGradingJob row per (attempt, essay question); a row
 * with status FAILED is the authoritative record of a grading failure. These
 * endpoints give admins visibility (list, filtered/searchable/paginated) plus
 * a retry action that re-enqueues through the SAME idempotent primitive the
 * quiz flow uses (enqueueAiGrading) — resetting FAILED→PENDING and re-adding
 * the BullMQ job (jobId-deduped, so replays are safe).
 *
 * The AiGradingJob model lives in core Prisma (not in the aiGrader module
 * folder), so listing works even when the module/queue is off; retry lazy-
 * requires the queue module and no-ops cleanly if it was deleted at runtime
 * (module-removal test stays green).
 */

const prisma = require('../config/db');

const JOB_STATUSES = ['PENDING', 'DONE', 'FAILED'];

function parseInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * GET /admin/ai-grading/jobs?status=FAILED&page=&limit=&search=
 * Lists AiGradingJob rows with admin-facing context: student, quiz/video/course
 * titles, error, tries. Default status = FAILED (the ops surface); PENDING/DONE
 * allowed for full-audit viewing. Leak-safe serializer — never answerKey,
 * responses, or essayFeedback.
 */
async function listAiGradingJobs(req, res) {
  try {
    const status = req.query.status || 'FAILED';
    if (!JOB_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    const page = Math.max(parseInteger(req.query.page) || 1, 1);
    const take = Math.max(1, Math.min(parseInteger(req.query.limit) || 20, 100));
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();

    const where = { status };
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
          tries: true,
          maxTries: true,
          confidence: true,
          applied: true,
          error: true,
          claimedAt: true,
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
      tries: job.tries,
      maxTries: job.maxTries,
      confidence: job.confidence,
      applied: job.applied,
      error: job.error,
      claimedAt: job.claimedAt,
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
 * Re-enqueues grading for FAILED jobs. With attemptIds → only those attempts;
 * without → ALL attempts that currently have a FAILED job. Uses the same
 * idempotent enqueue primitive as the quiz flow: qualified questions reset to
 * PENDING + BullMQ job re-added (jobId-deduped). Reports per-attempt how many
 * jobs were (re)queued and how many FAILED rows got cleared.
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

    const where = { status: 'FAILED' };
    if (uniqueAttemptIds.length > 0) where.attemptId = { in: uniqueAttemptIds };
    const failedRows = await prisma.aiGradingJob.findMany({
      where,
      select: { attemptId: true },
    });
    const attempts = [...new Set(failedRows.map((row) => row.attemptId))];

    if (attempts.length === 0) {
      return res.json({
        success: true,
        data: { attempts: 0, jobsEnqueued: 0, cleared: 0, perAttempt: [] },
      });
    }

    // Lazy require — never let a deleted/disabled module break the surface.
    let enqueueAiGrading = null;
    try {
      const queueModule = require('../services/aiGrader/queue');
      enqueueAiGrading = typeof queueModule.enqueueAiGrading === 'function' ? queueModule.enqueueAiGrading : null;
    } catch {
      enqueueAiGrading = null;
    }

    let jobsEnqueued = 0;
    let cleared = 0;
    const perAttempt = [];
    for (const attemptId of attempts) {
      const before = await prisma.aiGradingJob.count({ where: { attemptId, status: 'FAILED' } });
      let enqueued = 0;
      if (enqueueAiGrading) {
        // freshJobIds: re-schedule genuinely (bypass BullMQ's removeOnFail
        // dedupe window); the row-level upsert keeps it idempotent and the
        // worker re-validates every guard, so re-processing is impossible.
        enqueued = await enqueueAiGrading(attemptId, { freshJobIds: true }).catch(() => 0);
      }
      const after = await prisma.aiGradingJob.count({ where: { attemptId, status: 'FAILED' } });
      jobsEnqueued += enqueued;
      cleared += before - after;
      perAttempt.push({ attemptId, jobsEnqueued: enqueued, cleared: before - after });
    }

    return res.json({
      success: true,
      data: { attempts: attempts.length, jobsEnqueued, cleared, perAttempt },
    });
  } catch (error) {
    console.error('[AiGraderAdmin] retryFailedAiGrading error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  listAiGradingJobs,
  retryFailedAiGrading,
};