'use strict';

/**
 * quizzes.js — quiz, attempt and AI-grading read tools (read-only, Phase 1).
 *
 * Pass/fail needs a comparison between an attempt's scorePercent and its quiz's
 * passingScore — a column-to-column JOIN that Prisma cannot express (and raw SQL
 * is banned for agent tools). So every per-quiz metric here is derived from ONE
 * bounded sample of graded attempts (newest first, hard cap 500) aggregated in
 * JS, and every payload reports `sampled`/`sampledRows` so a truncated sample is
 * never presented as the whole truth.
 */

const { z } = require('zod');
const { readTool, clampTake, daysAgo } = require('./_kit');

const ATTEMPT_STATUSES = ['IN_PROGRESS', 'SUBMITTED', 'GRADING', 'GRADED', 'EXPIRED'];
const AI_JOB_STATUSES = ['PENDING', 'DONE', 'FAILED'];
const GRADED_SAMPLE_CAP = 500;
const FAILED_JOB_SAMPLE_CAP = 200;
const HOUR_MS = 60 * 60 * 1000;
const ERROR_MAX_CHARS = 200;

/** Date → ISO string, null-safe: no raw Date object ever leaves a tool payload. */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/** One decimal, null/undefined → 0. Used for every average this file returns. */
function oneDecimal(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
}

/** Share of `part` in `whole` as a one-decimal percentage; 0 when whole is 0. */
function percentage(part, whole) {
  return whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0;
}

/** Mean of the finite numbers in `values`, one decimal; 0 for an empty list. */
function mean(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return 0;
  return oneDecimal(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return oneDecimal(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** { [status]: count } over a full enum, so a status with no rows reads as 0. */
function toCountMap(grouped, statuses) {
  const out = {};
  for (const status of statuses) out[status] = 0;
  for (const row of grouped) {
    const key = row.status === null || row.status === undefined ? 'UNKNOWN' : String(row.status);
    out[key] = row._count._all;
  }
  return out;
}

/**
 * ONE bounded read of graded attempts, newest submitted first. Quiz ids only:
 * the per-quiz passingScore is joined in JS afterwards (see quizMetaByIds), which
 * keeps this query free of any relation pruning the DB would have to do.
 * `sampled` is true exactly when the cap was reached — provable, not guessed.
 */
async function sampleGradedAttempts(prisma, { since = null, courseSlug = null } = {}) {
  const where = { status: 'GRADED' };
  if (since) where.submittedAt = { gte: since };
  if (courseSlug) where.quiz = { bunnyVideo: { course: { slug: courseSlug } } };

  const rows = await prisma.quizAttempt.findMany({
    where,
    select: { quizId: true, scorePercent: true },
    take: GRADED_SAMPLE_CAP,
    orderBy: { submittedAt: 'desc' },
  });

  return { rows, sampled: rows.length >= GRADED_SAMPLE_CAP, sampledRows: rows.length };
}

/** quizId → { graded, scores } for the sampled attempts of one quiz. */
function bucketByQuiz(sampledRows) {
  const buckets = new Map();
  for (const row of sampledRows) {
    let bucket = buckets.get(row.quizId);
    if (!bucket) {
      bucket = { graded: 0, scores: [] };
      buckets.set(row.quizId, bucket);
    }
    bucket.graded += 1;
    // A GRADED attempt without a score cannot be judged: counted as graded, never
    // as passed or failed (guarded so passRate/failRate stay honest).
    if (Number.isFinite(row.scorePercent)) bucket.scores.push(row.scorePercent);
  }
  return buckets;
}

/** Quiz metadata for a set of ids — ONE query, no per-row follow-up. */
async function quizMetaByIds(prisma, ids) {
  if (ids.length === 0) return new Map();
  const quizzes = await prisma.quiz.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      slug: true,
      title: true,
      passingScore: true,
      bunnyVideo: { select: { title: true, course: { select: { slug: true } } } },
    },
  });
  const meta = new Map();
  for (const quiz of quizzes) meta.set(quiz.id, quiz);
  return meta;
}

/** A quiz's video/course context, null-safe for the optional video relation. */
function videoContext(quiz) {
  const video = quiz && quiz.bunnyVideo ? quiz.bunnyVideo : null;
  return {
    videoTitle: video ? video.title : null,
    courseSlug: video && video.course ? video.course.slug : null,
  };
}

const quizList = readTool({
  name: 'quiz_list',
  description:
    'قائمة الاختبارات مع مؤشرات الأداء لكل اختبار: الدرجة المطلوبة للنجاح، وعدد المحاولات المسموح بها، والمدة الزمنية، والدورة والفيديو التابع له، وعدد المحاولات الكلي، وعدد المحاولات المصحّحة، ومتوسط الدرجات، ونسبة النجاح. مؤشرات الأداء محسوبة على أحدث ٥٠٠ محاولة مصحّحة فقط ولا تغطي نافذة زمنية محددة؛ وعند بلوغ هذا الحد يظهر sampled=true مع sampledRows=500.',
  schema: z.object({
    take: z.number().int().min(1).max(50).optional().describe('عدد الاختبارات في النتيجة (١ إلى ٥٠، الافتراضي ٢٥)'),
    courseSlug: z.string().min(1).optional().describe('معرّف الدورة (slug) لحصر النتائج في دورة واحدة'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 25);

    // take+1 so `truncated` is proven by the extra row, never inferred from a count.
    const found = await prisma.quiz.findMany({
      where: args.courseSlug ? { bunnyVideo: { course: { slug: args.courseSlug } } } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        id: true,
        slug: true,
        title: true,
        passingScore: true,
        maxAttempts: true,
        timeLimitSec: true,
        bunnyVideo: { select: { title: true, course: { select: { slug: true } } } },
        _count: { select: { attempts: true } },
      },
    });

    const truncated = found.length > take;
    const page = found.slice(0, take);

    const sample = await sampleGradedAttempts(prisma);
    const buckets = bucketByQuiz(sample.rows);

    const rows = page.map((quiz) => {
      const scores = buckets.has(quiz.id) ? buckets.get(quiz.id).scores : [];
      const passed = scores.filter((score) => score >= quiz.passingScore).length;
      const context = videoContext(quiz);
      return {
        quizSlug: quiz.slug,
        title: quiz.title,
        passingScore: quiz.passingScore,
        maxAttempts: quiz.maxAttempts,
        timeLimitSec: quiz.timeLimitSec,
        courseSlug: context.courseSlug,
        videoTitle: context.videoTitle,
        attempts: quiz._count.attempts,
        graded: buckets.has(quiz.id) ? buckets.get(quiz.id).graded : 0,
        avgScore: mean(scores),
        passRate: percentage(passed, scores.length),
      };
    });

    return {
      rows,
      returned: rows.length,
      truncated,
      sampled: sample.sampled,
      sampledRows: sample.sampledRows,
    };
  },
});

const quizPassRates = readTool({
  name: 'quiz_pass_rates',
  description:
    'نسب النجاح لكل اختبار خلال نافذة زمنية منتهية الآن (بالأيام، الافتراضي ٩٠ يومًا) محسوبة من تاريخ التسليم، مع إمكانية حصر النتائج في دورة واحدة. يُرجع لكل اختبار عدد المحاولات المصحّحة والمصحّحة الناجحة والراسبة ونسبة النجاح ومتوسط الدرجات، مرتبة من الأقل نسبة نجاح إلى الأعلى. الحساب على أحدث ٥٠٠ محاولة مصحّحة داخل النافذة، ويظهر sampled=true إذا بلغنا هذا الحد.',
  schema: z.object({
    courseSlug: z.string().min(1).optional().describe('معرّف الدورة (slug) لحصر النتائج في دورة واحدة'),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('طول النافذة الزمنية بالأيام مقارنة بتاريخ التسليم (١ إلى ٣٦٥، الافتراضي ٩٠)'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد اختبارات في النتيجة (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const windowDays = args.windowDays || 90;
    const since = daysAgo(windowDays);
    const take = clampTake(args.take, 25);

    const sample = await sampleGradedAttempts(prisma, { since, courseSlug: args.courseSlug || null });
    const buckets = bucketByQuiz(sample.rows);
    const meta = await quizMetaByIds(prisma, Array.from(buckets.keys()));

    const all = [];
    for (const [quizId, bucket] of buckets) {
      const quiz = meta.get(quizId);
      // A quiz deleted between the two reads is skipped, never faked with a placeholder.
      if (!quiz) continue;
      const passed = bucket.scores.filter((score) => score >= quiz.passingScore).length;
      const failed = bucket.scores.length - passed;
      all.push({
        quizSlug: quiz.slug,
        title: quiz.title,
        courseSlug: videoContext(quiz).courseSlug,
        gradedAttempts: bucket.scores.length,
        passed,
        failed,
        passRate: percentage(passed, bucket.scores.length),
        avgScore: mean(bucket.scores),
      });
    }

    // Lowest pass rate first — the list is a "what needs attention" ranking.
    all.sort((a, b) => a.passRate - b.passRate || b.gradedAttempts - a.gradedAttempts);
    const rows = all.slice(0, take);

    return {
      windowDays,
      sinceIso: since.toISOString(),
      courseSlug: args.courseSlug || null,
      rows,
      returned: rows.length,
      truncated: all.length > take,
      sampled: sample.sampled,
      sampledRows: sample.sampledRows,
    };
  },
});

const quizAttemptSearch = readTool({
  name: 'quiz_attempt_search',
  description:
    'البحث في محاولات الاختبارات خلال نافذة زمنية منتهية الآن (بالأيام، الافتراضي ٣٠ يومًا) مقاسة من وقت بداية المحاولة، مع فلترة اختيارية بالحالة أو الاختبار أو الطالب. يُرجع أحدث المحاولات أولًا، ولكل محاولة الحالة ورقم المحاولة والنسبة والتواريخ بصيغة ISO وبيانات الطالب (الاسم والبريد والهاتف والصف) وبيانات الاختبار والفيديو والدورة. النتائج مقصوصة عند الحد المطلوب.',
  schema: z.object({
    status: z
      .enum([...ATTEMPT_STATUSES])
      .optional()
      .describe('حالة المحاولة: IN_PROGRESS (جارية) أو SUBMITTED (مسلّمة) أو GRADING (قيد التصحيح) أو GRADED (مصحّحة) أو EXPIRED (منتهية)'),
    quizSlug: z.string().min(1).optional().describe('معرّف الاختبار (slug) لحصر النتائج في اختبار واحد'),
    userSlug: z.string().min(1).optional().describe('معرّف الطالب (slug) لحصر النتائج في طالب واحد'),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('طول النافذة الزمنية بالأيام مقارنة بوقت بداية المحاولة (١ إلى ٣٦٥، الافتراضي ٣٠)'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد صفوف (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 0,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const windowDays = args.windowDays || 30;
    const since = daysAgo(windowDays);
    const take = clampTake(args.take, 25);

    const where = { startedAt: { gte: since } };
    if (args.status) where.status = args.status;
    if (args.quizSlug) where.quiz = { slug: args.quizSlug };
    if (args.userSlug) where.user = { slug: args.userSlug };

    const found = await prisma.quizAttempt.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: take + 1,
      select: {
        id: true,
        status: true,
        attemptNumber: true,
        scorePercent: true,
        startedAt: true,
        submittedAt: true,
        deadlineAt: true,
        autoSubmitted: true,
        user: { select: { slug: true, name: true, email: true, phoneNumber: true, grade: true } },
        quiz: {
          select: {
            slug: true,
            title: true,
            passingScore: true,
            bunnyVideo: { select: { title: true, course: { select: { slug: true } } } },
          },
        },
      },
    });

    const truncated = found.length > take;
    const rows = found.slice(0, take).map((attempt) => {
      const context = videoContext(attempt.quiz);
      return {
        id: attempt.id,
        status: attempt.status,
        attemptNumber: attempt.attemptNumber,
        scorePercent: attempt.scorePercent,
        autoSubmitted: attempt.autoSubmitted,
        startedAtIso: toIso(attempt.startedAt),
        submittedAtIso: toIso(attempt.submittedAt),
        deadlineAtIso: toIso(attempt.deadlineAt),
        student: attempt.user,
        quiz: {
          slug: attempt.quiz ? attempt.quiz.slug : null,
          title: attempt.quiz ? attempt.quiz.title : null,
          passingScore: attempt.quiz ? attempt.quiz.passingScore : null,
          videoTitle: context.videoTitle,
          courseSlug: context.courseSlug,
        },
      };
    });

    return { windowDays, sinceIso: since.toISOString(), rows, returned: rows.length, truncated };
  },
});

const quizDifficultyRanking = readTool({
  name: 'quiz_difficulty_ranking',
  description:
    'ترتيب الاختبارات من الأصعب إلى الأسهل حسب نسبة الرسوب في كل المحاولات المصحّحة (بدون نافذة زمنية محددة)، مع إمكانية تحديد أقل عدد محاولات مصحّحة لقبول الاختبار في الترتيب. يُرجع لكل اختبار عدد المحاولات المصحّحة والراسبين ونسبة الرسوب ومتوسط الدرجات. الحساب على أحدث ٥٠٠ محاولة مصحّحة، ويظهر sampled=true عند بلوغ هذا الحد.',
  schema: z.object({
    minAttempts: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('أقل عدد محاولات مصحّحة لقبول الاختبار في الترتيب (١ إلى ٢٠، الافتراضي ٣)'),
    take: z.number().int().min(1).max(25).optional().describe('عدد الاختبارات في النتيجة (١ إلى ٢٥، الافتراضي ١٠)'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const minAttempts = args.minAttempts || 3;
    const take = clampTake(args.take, 10);

    const sample = await sampleGradedAttempts(prisma);
    const buckets = bucketByQuiz(sample.rows);
    const meta = await quizMetaByIds(prisma, Array.from(buckets.keys()));

    const eligible = [];
    for (const [quizId, bucket] of buckets) {
      const quiz = meta.get(quizId);
      if (!quiz) continue;
      const attempts = bucket.scores.length;
      // Quizzes below the threshold carry no signal about difficulty.
      if (attempts < minAttempts) continue;
      const failed = bucket.scores.filter((score) => score < quiz.passingScore).length;
      eligible.push({
        quizSlug: quiz.slug,
        title: quiz.title,
        attempts,
        failed,
        failRate: percentage(failed, attempts),
        avgScore: mean(bucket.scores),
      });
    }

    eligible.sort((a, b) => b.failRate - a.failRate || b.attempts - a.attempts);
    const rows = eligible.slice(0, take);

    return {
      minAttempts,
      rows,
      returned: rows.length,
      truncated: eligible.length > take,
      sampled: sample.sampled,
      sampledRows: sample.sampledRows,
    };
  },
});

const gradingBacklog = readTool({
  name: 'grading_backlog',
  description:
    'حالة التصحيح المعلّقة في هذه اللحظة (بلا نافذة زمنية): عدد المحاولات بحالة GRADING (قيد التصحيح) وSUBMITTED (مسلّمة ولم تُصحّح)، وعدد مهام التصحيح الآلي حسب الحالة، وعدد تسليمات المهام بحالة PENDING. ويُدرج أقدم المحاولات المنتظرة للتصحيح، والمهام الفاشلة، وأقدم المهام المنتظرة، مع عمر أقدم مهمة تصحيح آلي بحالة PENDING بالساعات.',
  schema: z.object({
    take: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('أقصى عدد صفوف في كل قائمة (١ إلى ٥٠، الافتراضي ٢٠)'),
  }),
  cacheTtlSeconds: 15,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 20);

    const [gradingCount, submittedCount, jobsByStatusRaw, submissionsPending, gradingFound, failedJobsRaw, pendingJobsRaw] =
      await Promise.all([
        prisma.quizAttempt.count({ where: { status: 'GRADING' } }),
        prisma.quizAttempt.count({ where: { status: 'SUBMITTED' } }),
        prisma.aiGradingJob.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.submission.count({ where: { status: 'PENDING' } }),
        prisma.quizAttempt.findMany({
          where: { status: 'GRADING' },
          orderBy: { submittedAt: 'asc' },
          take: take + 1,
          select: {
            id: true,
            attemptNumber: true,
            submittedAt: true,
            user: { select: { slug: true, name: true, email: true } },
            quiz: { select: { title: true, bunnyVideo: { select: { title: true } } } },
          },
        }),
        prisma.aiGradingJob.findMany({
          where: { status: 'FAILED' },
          orderBy: { updatedAt: 'asc' },
          take,
          select: { attemptId: true, questionName: true, tries: true, maxTries: true, error: true, updatedAt: true },
        }),
        prisma.aiGradingJob.findMany({
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          take,
          select: { attemptId: true, questionName: true, tries: true, createdAt: true },
        }),
      ]);

    const truncated = gradingFound.length > take;
    const rows = gradingFound.slice(0, take).map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      submittedAtIso: toIso(attempt.submittedAt),
      student: attempt.user,
      quizTitle: attempt.quiz ? attempt.quiz.title : null,
      videoTitle: attempt.quiz && attempt.quiz.bunnyVideo ? attempt.quiz.bunnyVideo.title : null,
    }));

    // Ascending order guarantees element 0 IS the oldest pending job, so the age
    // is exact even when `take` cut the list short.
    const oldest = pendingJobsRaw.length > 0 ? pendingJobsRaw[0].createdAt : null;
    const oldestPendingAgeHours = oldest ? oneDecimal((Date.now() - oldest.getTime()) / HOUR_MS) : null;

    const failedJobs = failedJobsRaw.map((job) => ({
      attemptId: job.attemptId,
      questionName: job.questionName,
      tries: job.tries,
      maxTries: job.maxTries,
      // A raw stack trace/prompt dump would flood the model's context; 200 chars
      // is enough to recognize the failure class.
      error: job.error ? String(job.error).slice(0, ERROR_MAX_CHARS) : null,
      updatedAtIso: toIso(job.updatedAt),
    }));

    const pendingJobs = pendingJobsRaw.map((job) => ({
      attemptId: job.attemptId,
      questionName: job.questionName,
      tries: job.tries,
      createdAtIso: toIso(job.createdAt),
    }));

    return {
      counts: {
        attemptsGrading: gradingCount,
        attemptsSubmitted: submittedCount,
        submissionsPending,
      },
      aiJobsByStatus: toCountMap(jobsByStatusRaw, AI_JOB_STATUSES),
      oldestPendingAgeHours,
      rows,
      returned: rows.length,
      truncated,
      failedJobs: { rows: failedJobs, returned: failedJobs.length, truncated: failedJobsRaw.length >= take },
      pendingJobs: { rows: pendingJobs, returned: pendingJobs.length, truncated: pendingJobsRaw.length >= take },
    };
  },
});

const aiGradingStats = readTool({
  name: 'ai_grading_stats',
  description:
    'إحصاءات التصحيح الآلي خلال نافذة زمنية منتهية الآن (بالأيام، الافتراضي ٣٠ يومًا) مقاسة من وقت إنشاء المهمة: أعداد المهام حسب الحالة (PENDING/DONE/FAILED) مع متوسط الثقة، وعدد المهام التي طُبّق حكمها وعدد غير المطبّقة، وعدد المهام الفاشلة التي استنفدت محاولاتها. عدد المهام الفاشلة المستنفدة محسوب من عيّنة بحد أقصى ٢٠٠ صف، ويظهر sampled=true عند بلوغ الحد.',
  schema: z.object({
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('طول النافذة الزمنية بالأيام مقارنة بوقت إنشاء المهمة (١ إلى ٣٦٥، الافتراضي ٣٠)'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const windowDays = args.windowDays || 30;
    const since = daysAgo(windowDays);

    const [grouped, applied, notApplied, failedSample] = await Promise.all([
      prisma.aiGradingJob.groupBy({
        by: ['status'],
        _count: { _all: true },
        _avg: { confidence: true },
        where: { createdAt: { gte: since } },
      }),
      prisma.aiGradingJob.count({ where: { createdAt: { gte: since }, applied: true } }),
      prisma.aiGradingJob.count({ where: { createdAt: { gte: since }, applied: false } }),
      // `tries >= maxTries` is a column-to-column comparison Prisma cannot filter
      // on, so the exhausted-retry count comes from a bounded row sample instead.
      prisma.aiGradingJob.findMany({
        where: { createdAt: { gte: since }, status: 'FAILED' },
        select: { tries: true, maxTries: true },
        take: FAILED_JOB_SAMPLE_CAP,
      }),
    ]);

    const byStatus = {};
    for (const status of AI_JOB_STATUSES) byStatus[status] = { count: 0, avgConfidence: 0 };
    for (const row of grouped) {
      const key = row.status === null || row.status === undefined ? 'UNKNOWN' : String(row.status);
      byStatus[key] = { count: row._count._all, avgConfidence: oneDecimal(row._avg.confidence) };
    }

    const failedExhaustedRetries = failedSample.filter((job) => job.tries >= job.maxTries).length;

    return {
      windowDays,
      sinceIso: since.toISOString(),
      byStatus,
      applied,
      notApplied,
      failedExhaustedRetries,
      sampled: failedSample.length >= FAILED_JOB_SAMPLE_CAP,
      sampledRows: failedSample.length,
    };
  },
});

const essayGradingTurnaround = readTool({
  name: 'essay_grading_turnaround',
  description:
    'زمن تصحيح الأسئلة المقالية خلال نافذة زمنية منتهية الآن (بالأيام، الافتراضي ٣٠ يومًا) مقاسة من وقت تسليم المحاولة: حجم العيّنة ومتوسط الزمن ووسيطه وأسرع وأبطأ زمن بين التسليم والتصحيح، كلها بالساعات. العيّنة بحد أقصى ٢٠٠ محاولة مصحّحة مقاليًا، ويظهر sampled=true عند بلوغ الحد.',
  schema: z.object({
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('طول النافذة الزمنية بالأيام مقارنة بوقت تسليم المحاولة (١ إلى ٣٦٥، الافتراضي ٣٠)'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const windowDays = args.windowDays || 30;
    const since = daysAgo(windowDays);

    const attempts = await prisma.quizAttempt.findMany({
      where: { status: 'GRADED', essayGradedAt: { not: null }, submittedAt: { gte: since } },
      select: { submittedAt: true, essayGradedAt: true },
      take: 200,
      orderBy: { essayGradedAt: 'desc' },
    });

    // Rows with no submission time, or graded before they were submitted (data
    // anomaly), would poison the average — they are excluded, not clamped to 0.
    const hours = [];
    for (const attempt of attempts) {
      if (!(attempt.submittedAt instanceof Date) || !(attempt.essayGradedAt instanceof Date)) continue;
      const value = (attempt.essayGradedAt.getTime() - attempt.submittedAt.getTime()) / HOUR_MS;
      if (Number.isFinite(value) && value >= 0) hours.push(value);
    }

    return {
      windowDays,
      sinceIso: since.toISOString(),
      sampleSize: hours.length,
      avgHours: mean(hours),
      medianHours: median(hours),
      fastestHours: hours.length > 0 ? oneDecimal(Math.min(...hours)) : 0,
      slowestHours: hours.length > 0 ? oneDecimal(Math.max(...hours)) : 0,
      sampled: attempts.length >= 200,
    };
  },
});

module.exports = [
  quizList,
  quizPassRates,
  quizAttemptSearch,
  quizDifficultyRanking,
  gradingBacklog,
  aiGradingStats,
  essayGradingTurnaround,
];
