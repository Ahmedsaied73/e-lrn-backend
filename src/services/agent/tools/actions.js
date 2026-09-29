'use strict';

/**
 * actions.js — the mutating tool surface (Prisma-only, HITL-gated).
 *
 * Doctrine for every tool here:
 *  - Prisma only, no raw SQL. Where the invariant already lives in a service it
 *    is REUSED (gradeEssayAttempt owns its row-lock; reordering goes through
 *    bunnyVideoService) rather than re-implemented.
 *  - Every action returns `targetId` so execute() writes a precise audit row.
 *  - Cache invalidation mirrors the HTTP controller EXACTLY: a stale "not
 *    enrolled" answer right after an enroll is the most trust-destroying bug a
 *    copilot can ship.
 *  - Nothing here runs unless ctx.approved === true AND ctx.adminId is real —
 *    that gate lives in _kit.execute(), NOT here, so approval cannot be forged
 *    through tool arguments.
 *  - Audit action names reuse the existing HTTP literals where the operation is
 *    the same, so reporting by action sees one action regardless of channel.
 */

const { z } = require('zod');
const bcrypt = require('bcrypt');
const cache = require('../../../integrations/redis/cache');
const { actionTool, confirmableActionTool } = require('./_kit');
const { isValidSlug, randomBase36Slug } = require('../../../utils/slugs');

const GRADE_VALUES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];

// coursesController validates price with a local isInvalidPrice() (finite, >= 0,
// <= 1e9) that it does NOT export. The same ceiling is restated exactly once here
// and consumed by the course schemas, so the bound exists in one place per layer
// instead of being copied per tool.
const COURSE_PRICE_MAX_EGP = 1e9;

// Opaque public identifiers are exactly 12 lowercase base36 chars (see
// src/utils/slugs.js). Validating the FORMAT in the schema means a hallucinated
// identifier is rejected with a precise message instead of silently matching
// nothing in the database and confusing the next step.
const SLUG_RE = /^[a-z0-9]{12}$/;
const slugArg = (what) =>
  z.string().regex(SLUG_RE, 'معرّف غير صالح: يجب أن يكون ١٢ حرفاً/رقماً لاتينياً صغيراً').describe(`معرّف ${what} (١٢ خانة)`);

async function findStudent(prisma, userSlug) {
  return prisma.user.findUnique({
    where: { slug: userSlug },
    select: { id: true, slug: true, name: true, grade: true, role: true },
  });
}

async function findCourse(prisma, courseSlug) {
  return prisma.course.findUnique({
    where: { slug: courseSlug },
    select: { id: true, slug: true, title: true, price: true },
  });
}

/**
 * The /user/me payload cache (v1:me:{id}, 60s) holds pre-write fields and the HTTP
 * user paths drop it after every write. Never-throw by design: a Redis failure
 * only serves a ≤60s-stale profile, never worth failing a completed write for.
 */
async function invalidateMeCache(userId) {
  try {
    await cache.del(cache.buildKey('me', String(userId)));
  } catch {
    /* best-effort: the stale copy expires on its own TTL */
  }
}

/**
 * The course-cache invalidation set coursesController runs on EVERY course write
 * (list pages + the category facets). One copy here so a new write path cannot
 * forget one of the two and leave a stale title/price in front of admins.
 */
async function invalidateCourseCaches() {
  await cache.delPrefix('v1:courses:');
  await cache.del(cache.buildKey('search', 'cats'));
}

/** The invalidation set the HTTP enrollment paths perform — one copy, no drift. */
async function invalidateEnrollmentCaches(userId, courseId) {
  const quizService = require('../../quizService');
  await quizService.invalidateGateForUser(userId);
  await quizService.invalidateAchievementsForUser(userId);
  await cache.del(cache.buildKey('courses', 'byid', courseId, `u${userId}`));
}

const enrollStudent = actionTool({
  name: 'enroll_student',
  description:
    'تسجيل طالب في دورة بصلاحية إدارية (بدون دفع). يُستخدم عند طلب «سجّل الطالب في الدورة». ينفّذ فوراً عند استدعاء الأداة، ويعيد حالة التسجيل بعد التنفيذ.',
  schema: z.object({ userSlug: slugArg('الطالب'), courseSlug: slugArg('الدورة') }),
  audit: { action: 'ENROLL_CREATE', targetType: 'enrollment' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    if (!isValidSlug(args.userSlug) || !isValidSlug(args.courseSlug)) {
      return { ok: false, reason: 'INVALID_SLUG' };
    }

    const [student, course] = await Promise.all([
      findStudent(prisma, args.userSlug),
      findCourse(prisma, args.courseSlug),
    ]);
    if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };

    const existing = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: student.id, courseId: course.id } },
      select: { id: true, isPaid: true },
    });
    if (existing) {
      return {
        ok: false,
        reason: 'ALREADY_ENROLLED',
        enrollmentId: existing.id,
        isPaid: existing.isPaid,
        student: { slug: student.slug, name: student.name },
        course: { slug: course.slug, title: course.title },
      };
    }

    const now = new Date();
    const enrollment = await prisma.enrollment.create({
      data: {
        userId: student.id,
        courseId: course.id,
        isPaid: true,
        paymentDate: now,
        startedAt: now,
        lastAccess: now,
      },
      select: { id: true, createdAt: true, isPaid: true },
    });

    await invalidateEnrollmentCaches(student.id, course.id);

    return {
      ok: true,
      targetId: enrollment.id,
      enrollmentId: enrollment.id,
      isPaid: enrollment.isPaid,
      createdAtIso: enrollment.createdAt.toISOString(),
      student: { slug: student.slug, name: student.name, grade: student.grade },
      course: { slug: course.slug, title: course.title },
      note: 'تم التسجيل. لم يُرسل أي إشعار للطالب — استخدم أداة البث عند الحاجة.',
    };
  },
});

const unenrollStudent = actionTool({
  name: 'unenroll_student',
  description:
    'إلغاء تسجيل طالب من دورة (حذف سجل الاشتراك) بصلاحية إدارية. يُستخدم عند طلب «الغِ تسجيل الطالب» أو «اشِل الطالب من الدورة». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({ userSlug: slugArg('الطالب'), courseSlug: slugArg('الدورة') }),
  audit: { action: 'ENROLL_DELETE', targetType: 'enrollment' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    if (!isValidSlug(args.userSlug) || !isValidSlug(args.courseSlug)) {
      return { ok: false, reason: 'INVALID_SLUG' };
    }

    const [student, course] = await Promise.all([
      findStudent(prisma, args.userSlug),
      findCourse(prisma, args.courseSlug),
    ]);
    if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };

    const enrollment = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: student.id, courseId: course.id } },
      select: { id: true, progress: true, isPaid: true },
    });
    if (!enrollment) {
      return {
        ok: false,
        reason: 'NOT_ENROLLED',
        student: { slug: student.slug, name: student.name },
        course: { slug: course.slug, title: course.title },
      };
    }

    await prisma.enrollment.delete({ where: { id: enrollment.id } });
    await invalidateEnrollmentCaches(student.id, course.id);

    return {
      ok: true,
      targetId: enrollment.id,
      removedEnrollmentId: enrollment.id,
      progressAtRemoval: enrollment.progress,
      wasPaid: enrollment.isPaid,
      student: { slug: student.slug, name: student.name },
      course: { slug: course.slug, title: course.title },
    };
  },
});

const markEnrollmentPaid = actionTool({
  name: 'mark_enrollment_paid',
  description:
    'تحويل اشتراك طالب إلى «مدفوع» يدوياً مع تحديد مدة الصلاحية بالأيام (افتراضياً 365 يوماً). يُستخدم عند طلب «خلّي اشتراك الطالب مدفوع». لا ينشئ سجل دفع مالي وينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    userSlug: slugArg('الطالب'),
    courseSlug: slugArg('الدورة'),
    expiresInDays: z.number().int().min(1).max(3650).optional().describe('مدة الصلاحية بالأيام، افتراضياً 365'),
  }),
  audit: { action: 'ENROLL_MARK_PAID', targetType: 'enrollment' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    if (!isValidSlug(args.userSlug) || !isValidSlug(args.courseSlug)) {
      return { ok: false, reason: 'INVALID_SLUG' };
    }

    const [student, course] = await Promise.all([
      findStudent(prisma, args.userSlug),
      findCourse(prisma, args.courseSlug),
    ]);
    if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };

    const enrollment = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: student.id, courseId: course.id } },
      select: { id: true, isPaid: true, expiresAt: true, paymentDate: true },
    });
    if (!enrollment) {
      return {
        ok: false,
        reason: 'NOT_ENROLLED',
        student: { slug: student.slug, name: student.name },
        course: { slug: course.slug, title: course.title },
      };
    }

    const days = Number.isSafeInteger(args.expiresInDays) ? args.expiresInDays : 365;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const updated = await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { isPaid: true, paymentDate: now, expiresAt },
      select: { id: true, isPaid: true, paymentDate: true, expiresAt: true },
    });

    await invalidateEnrollmentCaches(student.id, course.id);

    return {
      ok: true,
      targetId: updated.id,
      before: {
        isPaid: enrollment.isPaid,
        paymentDateIso: enrollment.paymentDate ? enrollment.paymentDate.toISOString() : null,
        expiresAtIso: enrollment.expiresAt ? enrollment.expiresAt.toISOString() : null,
      },
      after: {
        isPaid: updated.isPaid,
        paymentDateIso: updated.paymentDate ? updated.paymentDate.toISOString() : null,
        expiresAtIso: updated.expiresAt ? updated.expiresAt.toISOString() : null,
        expiresInDays: days,
      },
      student: { slug: student.slug, name: student.name },
      course: { slug: course.slug, title: course.title },
      note: 'هذه صلاحية إدارية يدوية وليست عملية دفع — لا يوجد سجل Payment مقابل لها.',
    };
  },
});

const grantGateExemption = actionTool({
  name: 'grant_gate_exemption',
  description:
    'منح استثناء من بوابة الاختبار المتسلسل: يسمح لطالب بتخطي شرط النجاح في اختبار فيديو محدد. يُستخدم عند طلب «اعمل استثناء للطالب من الاختبار» أو «عدّيه من الفيديو». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    userSlug: slugArg('الطالب'),
    videoSlug: slugArg('الفيديو'),
    reason: z.string().min(3).max(300).optional().describe('سبب الاستثناء (يُحفظ في سجل التدقيق)'),
  }),
  audit: { action: 'GATE_EXEMPTION_GRANT', targetType: 'gateExemption' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const [student, video] = await Promise.all([
      findStudent(prisma, args.userSlug),
      prisma.bunnyVideo.findUnique({
        where: { slug: args.videoSlug },
        select: { id: true, slug: true, title: true, courseId: true },
      }),
    ]);
    if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };
    if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };

    let exemption;
    try {
      exemption = await prisma.gateExemption.upsert({
        where: { userId_bunnyVideoId: { userId: student.id, bunnyVideoId: video.id } },
        create: {
          userId: student.id,
          bunnyVideoId: video.id,
          grantedBy: ctx.adminId,
          reason: args.reason || null,
        },
        update: { grantedBy: ctx.adminId, reason: args.reason || null },
      });
    } catch (error) {
      // Narrow race (user/video deleted between check and write) → structured
      // refusal, never a raw FK error surfacing to the model.
      if (error.code === 'P2003') return { ok: false, reason: 'STUDENT_OR_VIDEO_NOT_FOUND' };
      throw error;
    }

    const quizService = require('../../quizService');
    await quizService.invalidateQuizMetaForUser(student.id);
    await quizService.invalidateGateForUser(student.id);

    return {
      ok: true,
      targetId: exemption.id,
      exemptionId: exemption.id,
      student: { slug: student.slug, name: student.name },
      video: { slug: video.slug, title: video.title },
      reason: args.reason || null,
    };
  },
});

const revokeGateExemption = actionTool({
  name: 'revoke_gate_exemption',
  description:
    'إلغاء استثناء بوابة اختبار سابق (برقم الاستثناء أو بمعرّفي الطالب والفيديو). يُستخدم عند طلب «الغِ الاستثناء». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z
    .object({
      exemptionId: z.number().int().positive().optional().describe('رقم الاستثناء'),
      userSlug: slugArg('الطالب').optional(),
      videoSlug: slugArg('الفيديو').optional(),
    })
    .refine((v) => Number.isSafeInteger(v.exemptionId) || Boolean(v.userSlug && v.videoSlug), {
      message: 'حدّد exemptionId أو كلاً من userSlug و videoSlug',
    }),
  audit: { action: 'GATE_EXEMPTION_REVOKE', targetType: 'gateExemption' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    let exemption = null;
    if (Number.isSafeInteger(args.exemptionId)) {
      exemption = await prisma.gateExemption.findUnique({
        where: { id: args.exemptionId },
        select: { id: true, userId: true, bunnyVideoId: true, reason: true },
      });
    } else {
      const [student, video] = await Promise.all([
        findStudent(prisma, args.userSlug),
        prisma.bunnyVideo.findUnique({ where: { slug: args.videoSlug }, select: { id: true } }),
      ]);
      if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };
      if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };
      exemption = await prisma.gateExemption.findUnique({
        where: { userId_bunnyVideoId: { userId: student.id, bunnyVideoId: video.id } },
        select: { id: true, userId: true, bunnyVideoId: true, reason: true },
      });
    }

    if (!exemption) return { ok: false, reason: 'EXEMPTION_NOT_FOUND' };

    await prisma.gateExemption.delete({ where: { id: exemption.id } });

    const quizService = require('../../quizService');
    await quizService.invalidateQuizMetaForUser(exemption.userId);
    await quizService.invalidateGateForUser(exemption.userId);

    return {
      ok: true,
      targetId: exemption.id,
      revokedExemptionId: exemption.id,
      userId: exemption.userId,
      videoId: exemption.bunnyVideoId,
      previousReason: exemption.reason,
    };
  },
});

const resetQuizAttempt = actionTool({
  name: 'reset_quiz_attempt',
  description:
    'حذف محاولة اختبار لطالب لإتاحة إعادة المحاولة (تُحذف الإجابات والنتيجة معها). يُستخدم عند طلب «صفّر محاولة الطالب» أو «خلّيه يعيد الاختبار». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({ attemptId: z.number().int().positive().describe('رقم المحاولة') }),
  audit: { action: 'QUIZ_ATTEMPT_RESET', targetType: 'attempt' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: args.attemptId },
      select: {
        id: true,
        userId: true,
        status: true,
        attemptNumber: true,
        scorePercent: true,
        quiz: { select: { bunnyVideoId: true, title: true } },
      },
    });
    if (!attempt) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };

    await prisma.quizAttempt.delete({ where: { id: attempt.id } });

    // Invalidate AFTER the delete (a concurrent read in between would re-cache
    // pre-delete state) using ids captured before it.
    const quizService = require('../../quizService');
    if (attempt.quiz) await quizService.invalidateQuizMeta(attempt.userId, attempt.quiz.bunnyVideoId);
    await quizService.invalidateGateForUser(attempt.userId);

    return {
      ok: true,
      targetId: attempt.id,
      removedAttempt: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        previousStatus: attempt.status,
        previousScorePercent: attempt.scorePercent,
        quizTitle: attempt.quiz ? attempt.quiz.title : null,
      },
    };
  },
});

const gradeEssay = actionTool({
  name: 'grade_essay',
  description:
    'تصحيح الأسئلة المقالية في محاولة اختبار: يحدّد درجة كل سؤال وملاحظة التصحيح ثم يعيد حساب النتيجة الإجمالية. يُستخدم عند طلب «صحّح مقالي الطالب». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    attemptId: z.number().int().positive().describe('رقم المحاولة'),
    essayScores: z.record(z.string(), z.number().min(0)).describe('خريطة اسم السؤال إلى الدرجة'),
    essayFeedback: z
      .record(z.string(), z.string().max(2000))
      .optional()
      .describe('خريطة اسم السؤال إلى ملاحظة التصحيح'),
  }),
  audit: { action: 'QUIZ_GRADE', targetType: 'attempt' },
  run: async (args, ctx) => {
    const quizService = require('../../quizService');
    try {
      // Reuses the service instead of re-implementing the mutation: it
      // serializes against concurrent AI verdict applications on the same
      // attempt (row lock) and invalidates its caches after commit.
      const updated = await quizService.gradeEssayAttempt(
        ctx.adminId,
        args.attemptId,
        args.essayScores,
        args.essayFeedback || {}
      );

      return {
        ok: true,
        targetId: args.attemptId,
        attempt: {
          attemptId: args.attemptId,
          status: updated.status,
          scorePercent: updated.scorePercent,
          earnedPoints: updated.earnedPoints,
          totalPoints: updated.totalPoints,
          essayGradedAtIso: updated.essayGradedAt ? updated.essayGradedAt.toISOString() : null,
        },
      };
    } catch (error) {
      if (error && error.statusCode === 404) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };
      if (error && error.statusCode === 400) {
        return { ok: false, reason: 'INVALID_ARGUMENTS', detail: error.message };
      }
      throw error;
    }
  },
});


const retryAiGrading = actionTool({
  name: 'retry_ai_grading',
  description:
    'إعادة إرسال محاولات فشل تصحيحها الآلي إلى طابور التصحيح الذكي (الأسئلة المقالية). يمكن تحديد محاولات بعينها أو تركها فارغة لإعادة كل الفاشلة (بحد أقصى 10 محاولات في الطلب). ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    attemptIds: z
      .array(z.number().int().positive())
      .max(20)
      .optional()
      .describe('أرقام المحاولات المطلوبة، اتركها فارغة لكل المحاولات الفاشلة'),
    maxAttempts: z.number().int().min(1).max(20).optional().describe('أقصى عدد محاولات في الطلب، افتراضياً 10'),
  }),
  audit: { action: 'AI_GRADING_RETRY', targetType: 'aiGradingJob' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    // Lazy require (repo doctrine): a disabled/deleted AI module must degrade to
    // a clear refusal, never a crash.
    let enqueueAiGrading = null;
    try {
      const queueModule = require('../../aiGrader/queue');
      enqueueAiGrading = typeof queueModule.enqueueAiGrading === 'function' ? queueModule.enqueueAiGrading : null;
    } catch {
      enqueueAiGrading = null;
    }
    if (!enqueueAiGrading) return { ok: false, reason: 'AI_GRADER_UNAVAILABLE' };

    const where = { status: 'FAILED' };
    if (Array.isArray(args.attemptIds) && args.attemptIds.length > 0) {
      where.attemptId = { in: args.attemptIds };
    }

    const failedRows = await prisma.aiGradingJob.findMany({ where, select: { attemptId: true }, take: 200 });
    const limit = Number.isSafeInteger(args.maxAttempts) ? args.maxAttempts : 10;
    const attempts = [...new Set(failedRows.map((row) => row.attemptId))].slice(0, limit);

    if (attempts.length === 0) {
      return { ok: true, attempts: 0, jobsEnqueued: 0, clearedFailedJobs: 0, perAttempt: [], note: 'لا توجد مهام تصحيح ذكي فاشلة.' };
    }

    let jobsEnqueued = 0;
    let cleared = 0;
    const perAttempt = [];
    for (const attemptId of attempts) {
      const before = await prisma.aiGradingJob.count({ where: { attemptId, status: 'FAILED' } });
      const enqueued = await enqueueAiGrading(attemptId, { freshJobIds: true }).catch(() => 0);
      const after = await prisma.aiGradingJob.count({ where: { attemptId, status: 'FAILED' } });
      jobsEnqueued += enqueued;
      cleared += before - after;
      perAttempt.push({ attemptId, jobsEnqueued: enqueued, clearedFailedJobs: before - after });
    }

    return { ok: true, attempts: attempts.length, jobsEnqueued, clearedFailedJobs: cleared, perAttempt };
  },
});

const broadcastNotification = confirmableActionTool({
  name: 'broadcast_notification',
  description:
    'إرسال إشعار جماعي داخلي يظهر في صندوق إشعارات المنصة فقط (لا بريد ولا رسائل خارجية). يتطلّب تحديد الجمهور و«عدد المستلمين المتوقّع»، ويُرفض التنفيذ إذا اختلف العدد الفعلي عن المتوقّع أو تجاوز الحد الأقصى — حماية من إرسال جماعي غير مقصود. يُرسل على خطوتين: استدعاء بلا توكن يعيد معاينة بعدد المستلمين، ثم إرسال بعد تأكيد المشرف بتوكن المعاينة.',
  schema: z.object({
    title: z.string().min(3).max(200).describe('عنوان الإشعار'),
    body: z.string().max(5000).optional().describe('نص الإشعار'),
    linkUrl: z.string().max(500).optional().describe('مسار داخلي يبدأ بـ / فقط'),
    audience: z.object({
      kind: z.enum(['all', 'grade', 'course']).describe('نوع الجمهور'),
      grade: z.enum(GRADE_VALUES).optional().describe('مطلوب عند الجمهور بنوع grade'),
      courseSlug: z.string().min(3).max(64).optional().describe('مطلوب عند الجمهور بنوع course'),
    }),
    expectedRecipients: z.number().int().min(0).max(100000).describe('عدد المستلمين المتوقّع كما أكّده المستخدم'),
    maxRecipients: z.number().int().min(1).max(500).optional().describe('الحد الأقصى المسموح، افتراضياً 500'),
  }),
  audit: { action: 'NOTIFICATION_BROADCAST', targetType: 'notification' },
  // Preview-only: resolves the audience and reports the REAL recipient count.
  // run() re-resolves at execution and still enforces expectedRecipients + the
  // cap, so audience drift between preview and confirm cannot over-send.
  preview: async (args) => {
    const config = require('../../../config/env');
    if (config.features && config.features.notifications === false) {
      return { ok: false, reason: 'NOTIFICATIONS_DISABLED' };
    }

    const notificationService = require('../../notifications/notificationService');

    let userIds;
    try {
      userIds = await notificationService.resolveAudience(args.audience);
    } catch (error) {
      return {
        ok: false,
        reason: error && error.statusCode === 404 ? 'AUDIENCE_NOT_FOUND' : 'INVALID_AUDIENCE',
        detail: error ? error.message : null,
      };
    }

    const cap = Number.isSafeInteger(args.maxRecipients) ? args.maxRecipients : 500;
    const actual = userIds.length;

    if (actual === 0) return { ok: false, reason: 'NO_RECIPIENTS', audience: args.audience };
    if (actual > cap) {
      return { ok: false, reason: 'TOO_MANY_RECIPIENTS', actual, cap, hint: 'حدّد الجمهور بدقة أكثر أو قسّم البث.' };
    }

    return {
      ok: true,
      recipients: actual,
      audience: args.audience,
      title: args.title,
      body: args.body ?? null,
      linkUrl: args.linkUrl ?? null,
      warning: 'بعد التأكيد سيصل هذا الإشعار لكل مستلم من هؤلاء في صندوق إشعاراتهم.',
    };
  },
  run: async (args) => {
    const config = require('../../../config/env');
    if (config.features && config.features.notifications === false) {
      return { ok: false, reason: 'NOTIFICATIONS_DISABLED' };
    }

    const notificationService = require('../../notifications/notificationService');

    let userIds;
    try {
      userIds = await notificationService.resolveAudience(args.audience);
    } catch (error) {
      return {
        ok: false,
        reason: error && error.statusCode === 404 ? 'AUDIENCE_NOT_FOUND' : 'INVALID_AUDIENCE',
        detail: error ? error.message : null,
      };
    }

    const cap = Number.isSafeInteger(args.maxRecipients) ? args.maxRecipients : 500;
    const actual = userIds.length;

    if (actual === 0) return { ok: false, reason: 'NO_RECIPIENTS', audience: args.audience };
    if (actual > cap) {
      return { ok: false, reason: 'TOO_MANY_RECIPIENTS', actual, cap, hint: 'حدّد الجمهور بدقة أكثر أو قسّم البث.' };
    }
    // The anti-hallucination guard: a model may not blast an audience the admin
    // has not explicitly confirmed the size of.
    if (actual !== args.expectedRecipients) {
      return {
        ok: false,
        reason: 'RECIPIENT_COUNT_MISMATCH',
        actual,
        expected: args.expectedRecipients,
        hint: 'أعد التأكيد بالعدد الصحيح قبل الإرسال.',
      };
    }

    const { count, batchId } = await notificationService.createForUsers({
      userIds,
      type: 'ADMIN_BROADCAST',
      title: args.title,
      body: args.body || null,
      linkUrl: args.linkUrl || null,
    });

    return {
      ok: true,
      targetId: null,
      recipients: count,
      batchId,
      audience: args.audience,
      title: args.title,
    };
  },
});

const markVideoFailed = actionTool({
  name: 'mark_video_failed',
  description:
    'تعليم فيديو عالق في المعالجة كـ«فاشل» مع ذكر السبب، ليظهر في قائمة الفيديوهات الفاشلة وتتاح إعادة رفعه من لوحة التحكم. يُستخدم عند طلب «علّم الفيديو ده فاشل» أو لإنهاء حالة معالجة عالقة. ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    videoSlug: slugArg('الفيديو'),
    reason: z.string().min(3).max(300).describe('سبب التعليم كفاشل (يُحفظ للمراجعة)'),
  }),
  audit: { action: 'VIDEO_MARK_FAILED', targetType: 'bunnyvideo' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const video = await prisma.bunnyVideo.findUnique({
      where: { slug: args.videoSlug },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };
    // READY is terminal in the state machine — refuse with a human explanation
    // rather than letting the service throw a 422 into the model's context.
    if (video.status === 'READY') {
      return { ok: false, reason: 'VIDEO_ALREADY_READY', hint: 'الفيديو جاهز بالفعل ولا يمكن تعليمه فاشلاً.' };
    }

    const bunnyVideoService = require('../../bunnyVideoService');
    try {
      const updated = await bunnyVideoService.markFailed(video.id, args.reason);
      return {
        ok: true,
        targetId: video.id,
        video: { slug: updated.slug, title: updated.title },
        beforeStatus: video.status,
        afterStatus: updated.status,
        reason: args.reason,
        note: 'لم يُحذف الفيديو من باني — إعادة الرفع متاحة من لوحة التحكم.',
      };
    } catch (error) {
      if (error && error.code === 'INVALID_VIDEO_STATE') {
        return { ok: false, reason: 'INVALID_VIDEO_STATE', detail: error.message };
      }
      throw error;
    }
  },
});

const reorderCourseVideos = actionTool({
  name: 'reorder_course_videos',
  description:
    'إعادة ترتيب فيديوهات دورة بالكامل: يجب تمرير معرّفات كل فيديوهات الدورة بالترتيب المطلوب (بدون نقص أو تكرار). يُستخدم عند طلب «رتّب الفيديوهات» أو «خلّي الفيديو ده الأول». ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    courseSlug: slugArg('الدورة'),
    videoSlugs: z
      .array(z.string().min(3).max(64))
      .min(1)
      .max(100)
      .describe('معرّفات كل فيديوهات الدورة بالترتيب المطلوب من الأول للأخير'),
  }),
  audit: { action: 'VIDEO_REORDER', targetType: 'course' },
  run: async (args, ctx) => {
    const bunnyVideoService = require('../../bunnyVideoService');
    try {
      const rows = await bunnyVideoService.reorderVideos(args.courseSlug, args.videoSlugs, ctx.adminId);
      const course = await ctx.prisma.course.findUnique({
        where: { slug: args.courseSlug },
        select: { id: true },
      });
      return {
        ok: true,
        targetId: course ? course.id : null,
        courseSlug: args.courseSlug,
        count: rows.length,
        videos: rows.map((row) => ({ slug: row.slug, title: row.title, position: row.position })),
      };
    } catch (error) {
      // AppError carries a stable code (COURSE_NOT_FOUND, INVALID_VIDEO_IDS…).
      if (error && error.code) return { ok: false, reason: error.code, detail: error.message };
      throw error;
    }
  },
});

const updateCoursePrice = actionTool({
  name: 'update_course_price',
  description:
    'تحديث سعر دورة بالجنيه المصري (رقم صحيح بدون كسور، و0 تعني مجانية). يُستخدم عند طلب «غيّر سعر الدورة». الاشتراكات الحالية لا تتأثر. ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    courseSlug: slugArg('الدورة'),
    priceEgp: z.number().int().min(0).max(1000000).describe('السعر بالجنيه المصري كرقم صحيح'),
  }),
  audit: { action: 'COURSE_UPDATE', targetType: 'course' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const course = await prisma.course.findUnique({
      where: { slug: args.courseSlug },
      select: { id: true, slug: true, title: true, price: true },
    });
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };
    if (course.price === args.priceEgp) {
      return { ok: true, targetId: course.id, unchanged: true, priceEgp: course.price };
    }

    const updated = await prisma.course.update({
      where: { id: course.id },
      data: { price: args.priceEgp },
      select: { id: true, price: true },
    });

    // Mirrors the HTTP path exactly: the course list and the category facets are
    // cached, so a new price must not linger behind them.
    await invalidateCourseCaches();

    return {
      ok: true,
      targetId: updated.id,
      course: { slug: course.slug, title: course.title },
      beforePriceEgp: course.price,
      afterPriceEgp: updated.price,
      note: 'الاشتراكات القائمة لم تتأثر — السعر الجديد يُطبَّق على عمليات الشراء القادمة.',
    };
  },
});

const createStudent = actionTool({
  name: 'create_student',
  description:
    'إنشاء حساب طالب جديد بالاسم والبريد الإلكتروني وكلمة المرور (٨ أحرف على الأقل) ورقم الهاتف والصف الدراسي. يُستخدم عند طلب «أضف طالباً» أو «أنشئ حساب طالب». يفشل إذا كان البريد أو الهاتف مستخدماً من قبل، وينفّذ فوراً عند استدعاء الأداة، ويعيد معرّف الطالب (slug) وبياناته دون أي بيانات دخول.',
  schema: z.object({
    name: z.string().min(2).max(120).describe('اسم الطالب كاملاً'),
    email: z.string().email().max(190).describe('البريد الإلكتروني للطالب (فريد)'),
    password: z.string().min(8).max(200).describe('كلمة مرور الطالب: ٨ أحرف على الأقل'),
    phoneNumber: z.string().min(6).max(20).describe('رقم هاتف الطالب (فريد)'),
    grade: z
      .enum(GRADE_VALUES)
      .describe('الصف الدراسي: FIRST_SECONDARY أو SECOND_SECONDARY أو THIRD_SECONDARY'),
  }),
  audit: { action: 'USER_CREATE', targetType: 'user' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const email = args.email.trim().toLowerCase();
    const phoneNumber = args.phoneNumber.trim();

    // Mirrors authController.register: the pre-checks turn the HTTP 409 into a
    // precise, actionable reason instead of a generic write failure.
    const existingEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingEmail) return { ok: false, reason: 'EMAIL_TAKEN' };
    const existingPhone = await prisma.user.findUnique({ where: { phoneNumber }, select: { id: true } });
    if (existingPhone) return { ok: false, reason: 'PHONE_TAKEN' };

    // One hashing policy for the whole platform: the register path's cost (10).
    const hashedPassword = await bcrypt.hash(args.password, 10);

    let created;
    try {
      created = await prisma.user.create({
        data: {
          name: args.name.trim(),
          email,
          phoneNumber,
          password: hashedPassword,
          grade: args.grade,
          slug: randomBase36Slug(),
        },
        select: { id: true, slug: true, name: true, email: true, phoneNumber: true, grade: true, role: true },
      });
    } catch (error) {
      // The pre-checks are not atomic: a concurrent register of the same email or
      // phone lands here as P2002 — same refusal, still never a raw DB error.
      if (error.code === 'P2002') return { ok: false, reason: 'EMAIL_OR_PHONE_TAKEN' };
      throw error;
    }

    return {
      ok: true,
      targetId: created.id,
      student: {
        slug: created.slug,
        name: created.name,
        email: created.email,
        phoneNumber: created.phoneNumber,
        grade: created.grade,
        role: created.role,
      },
      note: 'لم تُنشأ جلسة دخول للطالب — يدخل بكلمة المرور التي حدّدتها.',
    };
  },
});

const updateStudent = actionTool({
  name: 'update_student',
  description:
    'تعديل بيانات طالب: الاسم أو الصف الدراسي أو رقم الهاتف (حقل واحد على الأقل). يُستخدم عند طلب «عدّل بيانات الطالب» أو «انقل الطالب للصف الثالث». لا يغيّر البريد أو كلمة المرور، وينفّذ فوراً عند استدعاء الأداة، ويعيد الحقول المتغيّرة.',
  schema: z
    .object({
      userSlug: slugArg('الطالب'),
      name: z.string().min(2).max(120).optional().describe('الاسم الجديد للطالب'),
      grade: z.enum(GRADE_VALUES).optional().describe('الصف الدراسي الجديد'),
      phoneNumber: z.string().min(6).max(20).optional().describe('رقم الهاتف الجديد (فريد)'),
    })
    .strict()
    .refine((v) => Boolean(v.name || v.grade || v.phoneNumber), {
      message: 'حدّد حقلاً واحداً على الأقل: name أو grade أو phoneNumber',
    }),
  audit: { action: 'USER_UPDATE', targetType: 'user' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const student = await findStudent(prisma, args.userSlug);
    if (!student) return { ok: false, reason: 'STUDENT_NOT_FOUND' };

    // The field set PUT /user/:userId allows an ADMIN to change on someone else.
    // email/password stay on the console path: a model must never be able to mint
    // or rotate a student's credentials.
    const data = {};
    if (args.name) data.name = args.name.trim();
    if (args.grade) data.grade = args.grade;
    if (args.phoneNumber) data.phoneNumber = args.phoneNumber.trim();

    let updated;
    try {
      updated = await prisma.user.update({
        where: { id: student.id },
        data,
        select: { id: true, slug: true, name: true, grade: true, phoneNumber: true },
      });
    } catch (error) {
      if (error.code === 'P2002') return { ok: false, reason: 'PHONE_TAKEN' };
      throw error;
    }

    await invalidateMeCache(student.id);

    return {
      ok: true,
      targetId: updated.id,
      student: {
        slug: updated.slug,
        name: updated.name,
        grade: updated.grade,
        phoneNumber: updated.phoneNumber,
      },
      changedFields: Object.keys(data),
      before: { name: student.name, grade: student.grade },
    };
  },
});

const createCourse = actionTool({
  name: 'create_course',
  description:
    'إنشاء دورة جديدة بالعنوان والوصف والسعر بالجنيه المصري والصف الدراسي (والتصنيف والصورة اختياريان). تُنسب الدورة إلى المشرف الذي وافق عليها. ينفّذ فوراً عند استدعاء الأداة، ويعيد معرّف الدورة (slug) وسعرها وصفّها.',
  schema: z.object({
    title: z.string().min(3).max(200).describe('عنوان الدورة'),
    description: z.string().min(10).max(5000).describe('وصف الدورة'),
    priceEgp: z
      .number()
      .int()
      .min(0)
      .max(COURSE_PRICE_MAX_EGP)
      .describe('السعر بالجنيه المصري كرقم صحيح بدون كسور، و0 تعني مجانية'),
    grade: z
      .enum(GRADE_VALUES)
      .describe('الصف الدراسي: FIRST_SECONDARY أو SECOND_SECONDARY أو THIRD_SECONDARY'),
    category: z.string().min(2).max(100).optional().describe('تصنيف الدورة (اختياري)'),
    thumbnail: z.string().url().max(500).optional().describe('رابط صورة الدورة (اختياري)'),
  }),
  audit: { action: 'COURSE_CREATE', targetType: 'course' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    let course;
    try {
      course = await prisma.course.create({
        data: {
          title: args.title.trim(),
          slug: randomBase36Slug(),
          description: args.description.trim(),
          price: args.priceEgp,
          grade: args.grade,
          category: args.category || undefined,
          thumbnail: args.thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
          // Attribution is the approving admin. coursesController only falls back
          // to findFirst({ role: 'ADMIN' }) for direct script invocation with NO
          // user context — an agent action always has one, so a "first admin"
          // guess here would silently mis-attribute the course.
          teacherId: ctx.adminId,
        },
        select: { id: true, slug: true, title: true, price: true, grade: true, category: true },
      });
    } catch (error) {
      // The approving admin row disappeared between approval and execution.
      if (error.code === 'P2003') return { ok: false, reason: 'ADMIN_NOT_FOUND' };
      throw error;
    }

    await invalidateCourseCaches();

    return {
      ok: true,
      targetId: course.id,
      course: {
        slug: course.slug,
        title: course.title,
        priceEgp: course.price,
        grade: course.grade,
        category: course.category,
      },
      teacherId: ctx.adminId,
      note: 'الدورة أُنشئت بدون فيديوهات — تُضاف الفيديوهات من لوحة التحكم.',
    };
  },
});

const updateCourse = actionTool({
  name: 'update_course',
  description:
    'تعديل بيانات دورة: العنوان أو الوصف أو السعر بالجنيه المصري أو الصف الدراسي أو التصنيف أو الصورة (حقل واحد على الأقل). يُستخدم عند طلب «عدّل بيانات الدورة». ينفّذ فوراً عند استدعاء الأداة، ويعيد الحقول المتغيّرة.',
  schema: z
    .object({
      courseSlug: slugArg('الدورة'),
      title: z.string().min(3).max(200).optional().describe('العنوان الجديد للدورة'),
      description: z.string().min(10).max(5000).optional().describe('الوصف الجديد للدورة'),
      priceEgp: z
        .number()
        .int()
        .min(0)
        .max(COURSE_PRICE_MAX_EGP)
        .optional()
        .describe('السعر الجديد بالجنيه المصري كرقم صحيح، و0 تعني مجانية'),
      grade: z.enum(GRADE_VALUES).optional().describe('الصف الدراسي الجديد'),
      category: z.string().min(2).max(100).optional().describe('التصنيف الجديد'),
      thumbnail: z.string().url().max(500).optional().describe('رابط الصورة الجديد'),
    })
    .strict()
    .refine(
      (v) =>
        Boolean(v.title || v.description || v.priceEgp !== undefined || v.grade || v.category || v.thumbnail),
      { message: 'حدّد حقلاً واحداً على الأقل للتعديل' }
    ),
  audit: { action: 'COURSE_UPDATE', targetType: 'course' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const course = await findCourse(prisma, args.courseSlug);
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };

    // Exactly the columns updateCourse accepts. The HTTP surface has no separate
    // publish/isPublished step (the Course model has no such field), so "publish"
    // is folded in here rather than shipped as a tool that would update nothing.
    const data = {};
    if (args.title) data.title = args.title.trim();
    if (args.description) data.description = args.description.trim();
    if (args.priceEgp !== undefined) data.price = args.priceEgp;
    if (args.grade) data.grade = args.grade;
    if (args.category) data.category = args.category.trim();
    if (args.thumbnail) data.thumbnail = args.thumbnail.trim();

    const updated = await prisma.course.update({
      where: { id: course.id },
      data,
      select: { id: true, slug: true, title: true, price: true, grade: true, category: true },
    });

    await invalidateCourseCaches();

    return {
      ok: true,
      targetId: updated.id,
      course: {
        slug: updated.slug,
        title: updated.title,
        priceEgp: updated.price,
        grade: updated.grade,
        category: updated.category,
      },
      changedFields: Object.keys(data),
      before: { title: course.title, priceEgp: course.price },
    };
  },
});

// --- Videos (P2b) ---
//
// NOTE (v2 rebuild, Decision #18): the create_video tool was REMOVED from this catalogue.
// Creating a video is a two-step flow -- create the Bunny object, then upload the binary
// through POST /videos/:videoId/upload -- and video creation stays out of chat. The HTTP
// route and its VIDEO_CREATE audit action are untouched; only the chat-callable tool is
// gone. delete_video, reorder_course_videos and mark_video_failed remain.
const deleteVideo = confirmableActionTool({
  name: 'delete_video',
  description:
    'حذف فيديو نهائياً من Bunny Stream ومن قاعدة البيانات مع تقدّم الطلاب واختباره المرتبط به. إجراء غير قابل للتراجع ويتطلب معرّف الفيديو بدقة. يتم على خطوتين: استدعاء بلا توكن يعيد معاينة مما سيُحذف، ثم تنفيذ بعد تأكيد المشرف الصريح باستخدام توكن المعاينة.',
  // Phase 3 (handoff 3.3): no client-side "are you sure" flag — the server-issued
  // preview token is the confirmation, and it binds the exact arguments previewed.
  schema: z.object({
    videoSlug: slugArg('الفيديو'),
  }),
  audit: { action: 'VIDEO_DELETE', targetType: 'video' },
  preview: async (args, ctx) => {
    const video = await ctx.prisma.bunnyVideo.findUnique({
      where: { slug: args.videoSlug },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        course: { select: { title: true } },
        quiz: { select: { title: true } },
        _count: { select: { progress: true } },
      },
    });
    if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };
    return {
      ok: true,
      target: {
        video: {
          slug: video.slug,
          title: video.title,
          status: video.status,
          course: video.course ? video.course.title : null,
          quiz: video.quiz ? video.quiz.title : null,
          studentProgressRows: video._count.progress,
        },
      },
      irreversible: true,
      warning: 'الحذف نهائي: سيُحذف الفيديو من Bunny Stream مع تقدّم الطلاب المرتبط به واختباره المرتبط.',
    };
  },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const bunnyVideoService = require('../../bunnyVideoService');
    const video = await prisma.bunnyVideo.findUnique({
      where: { slug: args.videoSlug },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };

    try {
      // One procedure, one copy: this removes the Bunny object, the local row
      // (quizzes and progress cascade) and drops the course's video caches.
      const result = await bunnyVideoService.deleteVideo(video.id);
      return {
        ok: true,
        targetId: video.id,
        video: { slug: video.slug, title: video.title, bunnyVideoId: result.bunnyVideoId },
      };
    } catch (err) {
      if (err && err.code === 'VIDEO_NOT_FOUND') return { ok: false, reason: 'VIDEO_NOT_FOUND' };
      if (err && err.code === 'BUNNY_API_ERROR') {
        // Bunny refused and the service deletes the local row only AFTER Bunny
        // succeeds, so the video still exists and the admin can retry.
        return { ok: false, reason: 'BUNNY_UNAVAILABLE_RETRY_LATER' };
      }
      throw err;
    }
  },
});

// --- Quizzes (P2b) ---
//
// Quiz authoring is the one write whose payload is a whole SurveyJS document, so
// the tool delegates validation to the SAME two service functions the HTTP
// controller uses (validateSurveyJson + buildAnswerKey). Nothing about the schema
// is re-checked here: a second validator is a second source of truth, and the two
// would drift the first time one of them learned a new question type.

/** The cache drops both HTTP quiz paths perform, in one place, never fatal. */
async function invalidateQuizCaches(bunnyVideoId) {
  try {
    const { invalidateVideoCaches } = require('../../bunnyVideoService');
    const video = await require('../../../config/db').bunnyVideo.findUnique({
      where: { id: bunnyVideoId },
      select: { courseId: true },
    });
    if (video) await invalidateVideoCaches(video.courseId);
  } catch {
    // A stale videos-list cache self-heals on its TTL; never fail a save for it.
  }
  await cache.delPrefix(`v1:quiz:meta:${bunnyVideoId}:`);
}

const upsertQuiz = actionTool({
  name: 'upsert_quiz',
  description:
    'إنشاء أو تحديث اختبار فيديو: العنوان وتعريف أسئلة SurveyJS ومفتاح الإجابات ودرجة النجاح وعدد المحاولات والحد الزمني. يُستخدم عند طلب «أضف اختباراً للفيديو» أو «عدّل اختبار الفيديو». يُرفض أي تعريف أسئلة أو مفتاح إجابات غير صالح. ينفّذ فوراً عند استدعاء الأداة بالمعرّفات الدقيقة.',
  schema: z.object({
    videoSlug: slugArg('الفيديو'),
    title: z.string().min(2).max(200).describe('عنوان الاختبار'),
    surveyJson: z.record(z.string(), z.unknown()).describe('تعريف أسئلة SurveyJS ككائن JSON'),
    answerKey: z
      .record(z.string(), z.unknown())
      .describe('مفتاح الإجابات: كائن JSON مفتاحه اسم السؤال وقيمته الإجابة الصحيحة'),
    timeLimitSec: z.number().int().positive().optional().describe('الحد الزمني بالثواني (اختياري — بدونه لا حد زمني)'),
    passingScore: z.number().int().min(0).max(100).optional().describe('درجة النجاح من ٠ إلى ١٠٠ (الافتراضي ٥٠)'),
    maxAttempts: z.number().int().min(1).max(10).optional().describe('عدد المحاولات (١ إلى ١٠، الافتراضي ٣)'),
  }),
  // ONE literal, deliberately not the HTTP pair (QUIZ_CREATE / QUIZ_UPDATE): a
  // single tool performs both, and a label that depends on whether a row happened
  // to exist already is a label no report can group by.
  audit: { action: 'QUIZ_UPSERT', targetType: 'quiz' },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const quizService = require('../../quizService');

    const video = await prisma.bunnyVideo.findUnique({
      where: { slug: args.videoSlug },
      select: { id: true, title: true },
    });
    if (!video) return { ok: false, reason: 'VIDEO_NOT_FOUND' };

    const surveyValidation = quizService.validateSurveyJson(args.surveyJson);
    if (!surveyValidation.ok) {
      return { ok: false, reason: 'INVALID_SURVEY_JSON', details: surveyValidation.errors };
    }
    const keyValidation = quizService.buildAnswerKey(args.surveyJson, args.answerKey);
    if (!keyValidation.ok) {
      return { ok: false, reason: 'INVALID_ANSWER_KEY', details: keyValidation.errors };
    }

    const existing = await prisma.quiz.findUnique({
      where: { bunnyVideoId: video.id },
      select: { id: true, surveyJson: true },
    });

    const quiz = await prisma.quiz.upsert({
      where: { bunnyVideoId: video.id },
      create: {
        bunnyVideoId: video.id,
        title: args.title.trim(),
        slug: randomBase36Slug(),
        timeLimitSec: args.timeLimitSec ?? null,
        passingScore: args.passingScore ?? 50,
        maxAttempts: args.maxAttempts ?? 3,
        surveyJson: args.surveyJson,
        answerKey: keyValidation.answerKey,
      },
      update: {
        title: args.title.trim(),
        timeLimitSec: args.timeLimitSec ?? null,
        passingScore: args.passingScore ?? 50,
        maxAttempts: args.maxAttempts ?? 3,
        surveyJson: args.surveyJson,
        answerKey: keyValidation.answerKey,
      },
      select: { id: true, slug: true, title: true, passingScore: true, maxAttempts: true, timeLimitSec: true },
    });

    // Replaced question images orphan in the bucket — diff old vs new object lists
    // and remove the drop-outs. Best-effort, exactly like the controller: a storage
    // failure must never undo a saved quiz.
    try {
      const { extractBucketObjectNames, getSupabaseAdmin, getSupabaseBucket } =
        require('../../../integrations/supabase/supabaseClient');
      const oldNames = existing ? extractBucketObjectNames(existing.surveyJson) : [];
      const newNames = new Set(extractBucketObjectNames(args.surveyJson));
      const onlyOld = oldNames.filter((name) => !newNames.has(name));
      if (onlyOld.length > 0) {
        const { error } = await getSupabaseAdmin().storage.from(getSupabaseBucket()).remove(onlyOld);
        if (error) console.error('[agent/upsert_quiz] image cleanup error:', error.message);
      }
    } catch (cleanupErr) {
      console.error('[agent/upsert_quiz] image cleanup failed:', cleanupErr.message);
    }

    await invalidateQuizCaches(video.id);

    return {
      ok: true,
      targetId: quiz.id,
      created: !existing,
      quiz: {
        slug: quiz.slug,
        videoSlug: args.videoSlug,
        videoTitle: video.title,
        title: quiz.title,
        passingScore: quiz.passingScore,
        maxAttempts: quiz.maxAttempts,
        timeLimitSec: quiz.timeLimitSec,
      },
      note: existing
        ? 'تعديل الاختبار لا يمسّ محاولات الطلاب السابقة — المحاولات القائمة تبقى بدرجاتها.'
        : 'الاختبار أُنشئ — الطلاب يرونه في شاشة الفيديو بعد إكمال الفيديو السابق.',
    };
  },
});

const deleteQuiz = confirmableActionTool({
  name: 'delete_quiz',
  description:
    'حذف اختبار نهائياً مع كل محاولات الطلاب المسجّلة عليه. إجراء غير قابل للتراجع ويتطلب معرّف الاختبار بدقة. يتم على خطوتين: استدعاء بلا توكن يعيد معاينة بما سيُحذف وعدد المحاولات، ثم تنفيذ بعد تأكيد المشرف الصريح باستخدام توكن المعاينة.',
  schema: z.object({
    quizSlug: slugArg('الاختبار'),
  }),
  audit: { action: 'QUIZ_DELETE', targetType: 'quiz' },
  preview: async (args, ctx) => {
    const quiz = await ctx.prisma.quiz.findUnique({
      where: { slug: args.quizSlug },
      select: {
        id: true,
        title: true,
        bunnyVideo: { select: { title: true } },
        _count: { select: { attempts: true } },
      },
    });
    if (!quiz) return { ok: false, reason: 'QUIZ_NOT_FOUND' };
    return {
      ok: true,
      target: {
        quiz: {
          slug: args.quizSlug,
          title: quiz.title,
          video: quiz.bunnyVideo ? quiz.bunnyVideo.title : null,
          attemptRowsToDelete: quiz._count.attempts,
        },
      },
      irreversible: true,
      warning: 'الحذف نهائي: ستُحذف كل محاولات الطلاب على هذا الاختبار ولا يمكن استرجاع درجاتها.',
    };
  },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const quiz = await prisma.quiz.findUnique({
      where: { slug: args.quizSlug },
      select: {
        id: true,
        title: true,
        bunnyVideoId: true,
        surveyJson: true,
        _count: { select: { attempts: true } },
      },
    });
    if (!quiz) return { ok: false, reason: 'QUIZ_NOT_FOUND' };

    await prisma.quiz.delete({ where: { id: quiz.id } });

    // Storage cleanup AFTER the DB delete succeeded — a bucket failure must never
    // report a completed delete as failed.
    try {
      const { removeQuizImagesBestEffort } = require('../../../integrations/supabase/supabaseClient');
      await removeQuizImagesBestEffort(quiz.surveyJson);
    } catch (cleanupErr) {
      console.error('[agent/delete_quiz] storage cleanup error:', cleanupErr.message);
    }

    await invalidateQuizCaches(quiz.bunnyVideoId);

    // The attempt count is REPORTED, not used as a veto: an admin asking to delete
    // a quiz that has attempts is making an explicit, approved decision, and burying
    // it behind a second confirmation would be a gate the model has to satisfy.
    return {
      ok: true,
      targetId: quiz.id,
      quiz: { slug: args.quizSlug, title: quiz.title, deletedAttempts: quiz._count.attempts },
    };
  },
});

// --- Deletes (P2b, shipped last by product decision) ---
//
// These four are the only irreversible tools in the catalogue. They mirror their
// HTTP controllers statement for statement, including the ORDER the controller
// uses, because that order is what makes the operation survivable: the database
// work happens first and the remote/storage cleanup after it, best-effort, so a
// Bunny or Supabase outage can never leave a half-deleted course behind.
const deleteCourse = confirmableActionTool({
  name: 'delete_course',
  description:
    'حذف دورة نهائياً: الفيديوهات وتسجيلات الطلاب والشهادات والاختبارات المرتبطة بها، مع حذف فيديوهاتها من Bunny Stream وصور اختباراتها من التخزين. إجراء غير قابل للتراجع ويتطلب معرّف الدورة بدقة. يتم على خطوتين: استدعاء بلا توكن يعيد معاينة بعدد الفيديوهات والاشتراكات والشهادات المتأثرة، ثم تنفيذ بعد تأكيد المشرف الصريح باستخدام توكن المعاينة.',
  schema: z.object({
    courseSlug: slugArg('الدورة'),
  }),
  audit: { action: 'COURSE_DELETE', targetType: 'course' },
  preview: async (args, ctx) => {
    const course = await ctx.prisma.course.findUnique({
      where: { slug: args.courseSlug },
      select: {
        id: true,
        slug: true,
        title: true,
        _count: { select: { videos: true, enrollments: true, certificates: true } },
      },
    });
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };
    const bunnyVideoRows = await ctx.prisma.bunnyVideo.count({ where: { courseId: course.id } });
    return {
      ok: true,
      target: {
        course: {
          slug: course.slug,
          title: course.title,
          legacyVideos: course._count.videos,
          bunnyVideos: bunnyVideoRows,
          enrollments: course._count.enrollments,
          certificates: course._count.certificates,
        },
      },
      irreversible: true,
      warning: 'الحذف نهائي: الفيديوهات من Bunny Stream، والاشتراكات، والشهادات، والاختبارات وكل محاولات طلابها — كلها ستُحذف مع الدورة.',
    };
  },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const bunnyClient = require('../../../integrations/bunny/bunnyStreamClient');

    const course = await prisma.course.findUnique({
      where: { slug: args.courseSlug },
      select: {
        id: true,
        title: true,
        _count: { select: { videos: true, enrollments: true, certificates: true } },
      },
    });
    if (!course) return { ok: false, reason: 'COURSE_NOT_FOUND' };
    const courseId = course.id;

    // Snapshots taken BEFORE the transaction, because the rows they describe are
    // exactly what it deletes (and the quiz rows cascade with the BunnyVideos).
    const [bunnyVideos, quizRows, enrollmentRows] = await Promise.all([
      prisma.bunnyVideo.findMany({ where: { courseId }, select: { bunnyVideoId: true } }),
      prisma.quiz.findMany({ where: { bunnyVideo: { courseId } }, select: { surveyJson: true } }),
      prisma.enrollment.findMany({ where: { courseId }, select: { userId: true } }),
    ]);
    const enrolledUserIds = enrollmentRows.map((row) => row.userId);

    await prisma.$transaction(async (tx) => {
      // Children whose FK is Restrict are removed explicitly — a bare
      // course.delete would throw P2003 for any course with rows.
      if (course._count.videos > 0) await tx.video.deleteMany({ where: { courseId } });
      if (course._count.enrollments > 0) await tx.enrollment.deleteMany({ where: { courseId } });
      if (course._count.certificates > 0) await tx.certificate.deleteMany({ where: { courseId } });

      // A course inside a learning path must be DISCONNECTED, not delete-cascaded
      // (the path itself is a separate product object).
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

    // Remote cleanup after the DB commit — per-video errors are logged, never fatal:
    // the delete has already happened and failing here would only lie to the admin.
    let remoteCleanupFailures = 0;
    for (const video of bunnyVideos) {
      try {
        await bunnyClient.deleteVideo(video.bunnyVideoId);
      } catch (cleanupErr) {
        remoteCleanupFailures += 1;
        console.error(`[agent/delete_course] Failed to delete Bunny video ${video.bunnyVideoId}:`, cleanupErr.message);
      }
    }

    try {
      const { removeQuizImagesBestEffort } = require('../../../integrations/supabase/supabaseClient');
      for (const quiz of quizRows) {
        await removeQuizImagesBestEffort(quiz.surveyJson);
      }
    } catch (cleanupErr) {
      console.error('[agent/delete_course] Storage cleanup error:', cleanupErr.message);
    }

    await cache.delPrefix('v1:courses:');
    await cache.delPrefix(`v1:videos:course:${courseId}:`);
    await cache.del(cache.buildKey('search', 'cats'));

    // Every enrolled student's cached gate verdict still says allowed:true for a
    // course they are no longer in — drop the namespace so the next evaluation
    // fails closed from the database.
    try {
      const quizService = require('../../quizService');
      await Promise.all(enrolledUserIds.map((userId) => quizService.invalidateGateForUser(userId)));
    } catch (err) {
      console.error('[agent/delete_course] gate invalidation failed:', err.message);
    }

    return {
      ok: true,
      targetId: courseId,
      course: {
        slug: args.courseSlug,
        title: course.title,
        deletedEnrollments: course._count.enrollments,
        deletedVideos: bunnyVideos.length,
      },
      remoteCleanupFailures,
      note:
        remoteCleanupFailures > 0
          ? 'تم الحذف من قاعدة البيانات، لكن فشل حذف بعض الفيديوهات من Bunny Stream — راجع سجلات الخادم.'
          : null,
    };
  },
});

const deleteUser = confirmableActionTool({
  name: 'delete_user',
  description:
    'حذف حساب مستخدم نهائياً مع تسجيلاته في الدورات ومدفوعاته وشهاداته ومحاولاته. إجراء غير قابل للتراجع، ولا يمكن حذف حساب المشرف نفسه، ولا حساب يملك دورات. يتم على خطوتين: استدعاء بلا توكن يعيد معاينة بالحساب وعدد اشتراكاته، ثم تنفيذ بعد تأكيد المشرف الصريح باستخدام توكن المعاينة.',
  schema: z.object({
    userSlug: slugArg('المستخدم'),
  }),
  audit: { action: 'USER_DELETE', targetType: 'user' },
  preview: async (args, ctx) => {
    const user = await ctx.prisma.user.findUnique({
      where: { slug: args.userSlug },
      select: { id: true, slug: true, name: true, role: true, grade: true },
    });
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
    // The same refusals run() makes, surfaced BEFORE the confirmation token:
    // previewing a delete that can never execute would only waste the admin's
    // confirmation on a guaranteed failure.
    if (user.id === ctx.adminId) return { ok: false, reason: 'CANNOT_DELETE_SELF' };
    const ownedCourses = await ctx.prisma.course.count({ where: { teacherId: user.id } });
    if (ownedCourses > 0) return { ok: false, reason: 'USER_OWNS_COURSES', ownedCourses };
    const enrollments = await ctx.prisma.enrollment.count({ where: { userId: user.id } });
    return {
      ok: true,
      target: {
        user: { slug: user.slug, name: user.name, role: user.role, grade: user.grade ?? null },
        enrollments,
      },
      irreversible: true,
      warning: 'الحذف نهائي: اشتراكات الطالب ومدفوعاته وشهاداته ومحاولاته كلها ستُحذف مع الحساب.',
    };
  },
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    const user = await prisma.user.findUnique({
      where: { slug: args.userSlug },
      select: { id: true, slug: true, name: true, role: true },
    });
    if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

    // The approving admin cannot delete themselves: the approval would be
    // attributed to a row that no longer exists, and the audit trail would lose
    // its actor.
    if (user.id === ctx.adminId) return { ok: false, reason: 'CANNOT_DELETE_SELF' };

    // Course owners must release their courses first — a bulk delete would bypass
    // the Bunny remote cleanup, leaving orphans on Bunny's servers.
    const ownedCourses = await prisma.course.count({ where: { teacherId: user.id } });
    if (ownedCourses > 0) {
      return { ok: false, reason: 'USER_OWNS_COURSES', ownedCourses };
    }

    // Several child relations default to Restrict, so a bare user.delete throws
    // P2003 for any user with rows. Explicit cascade, in one transaction.
    await prisma.$transaction([
      prisma.quizAttempt.deleteMany({ where: { userId: user.id } }),
      prisma.gateExemption.deleteMany({ where: { userId: user.id } }),
      prisma.assignmentAnswer.deleteMany({ where: { userId: user.id } }),
      prisma.submission.deleteMany({ where: { userId: user.id } }),
      prisma.bunnyVideoProgress.deleteMany({ where: { userId: user.id } }),
      prisma.enrollment.deleteMany({ where: { userId: user.id } }),
      prisma.payment.deleteMany({ where: { userId: user.id } }),
      prisma.certificate.deleteMany({ where: { userId: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);

    // Their access token stays valid until it expires, but the enrollment rows are
    // gone — a cached gate verdict would answer allowed:true in the meantime.
    const quizService = require('../../quizService');
    await quizService.invalidateGateForUser(user.id);
    await invalidateMeCache(user.id);

    return {
      ok: true,
      targetId: user.id,
      user: { slug: user.slug, name: user.name, role: user.role },
      note: 'الحساب حُذف. رمز الدخول الحالي يبقى صالحاً حتى انتهاء صلاحيته القصيرة (١٥ دقيقة)، ولا يستطيع الوصول لأي دورة.',
    };
  },
});

module.exports = [
  enrollStudent,
  unenrollStudent,
  markEnrollmentPaid,
  grantGateExemption,
  revokeGateExemption,
  resetQuizAttempt,
  gradeEssay,
  retryAiGrading,
  broadcastNotification,
  markVideoFailed,
  reorderCourseVideos,
  updateCoursePrice,
  createStudent,
  updateStudent,
  createCourse,
  updateCourse,
  deleteVideo,
  upsertQuiz,
  deleteQuiz,
  deleteCourse,
  deleteUser,
];
