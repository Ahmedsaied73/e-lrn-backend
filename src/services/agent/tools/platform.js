'use strict';

/**
 * platform.js — whole-platform aggregate tools (read-only, Phase 1).
 *
 * These answer "how big is the platform": one round of counts, no row scans.
 * Everything is a Prisma count/groupBy — no raw SQL, no per-row loops — so the
 * cost is fixed regardless of what the admin asks.
 */

const { z } = require('zod');
const { readTool, daysAgo } = require('./_kit');

/** { [status]: count } from a Prisma groupBy on one enum column. */
function toCountMap(grouped) {
  const out = {};
  for (const row of grouped) {
    const key = row.status === null || row.status === undefined ? 'UNKNOWN' : String(row.status);
    out[key] = row._count._all;
  }
  return out;
}

const platformOverview = readTool({
  name: 'platform_overview',
  description:
    'نظرة عامة على المنصة: عدد الطلاب والمشرفين والدورات والاشتراكات (مدفوعة/غير مدفوعة/مكتملة)، وعدد الاختبارات ومحاولاتها حسب الحالة، وفيديوهات باني حسب حالة المعالجة، والشهادات، والمهام المعلّقة للتصحيح، وأرقام آخر ٧ أيام.',
  cacheTtlSeconds: 30,
  run: async (_args, ctx) => {
    const prisma = ctx.prisma;
    const since7 = daysAgo(7);

    const [
      students,
      admins,
      courses,
      enrollments,
      paidEnrollments,
      completedEnrollments,
      quizzes,
      attemptsByStatusRaw,
      videosByStatusRaw,
      videosTotal,
      certificates,
      gradingAttempts,
      pendingAiJobs,
      submissionsPending,
      newStudents7d,
      newEnrollments7d,
      attemptsTotal,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null } }),
      prisma.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
      prisma.course.count({ where: { deletedAt: null } }),
      prisma.enrollment.count(),
      prisma.enrollment.count({ where: { isPaid: true } }),
      prisma.enrollment.count({ where: { isCompleted: true } }),
      prisma.quiz.count(),
      prisma.quizAttempt.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bunnyVideo.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bunnyVideo.count(),
      prisma.certificate.count(),
      prisma.quizAttempt.count({ where: { status: 'GRADING' } }),
      prisma.aiGradingJob.count({ where: { status: 'PENDING' } }),
      prisma.submission.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { role: 'STUDENT', deletedAt: null, createdAt: { gte: since7 } } }),
      prisma.enrollment.count({ where: { createdAt: { gte: since7 } } }),
      prisma.quizAttempt.count(),
    ]);

    return {
      windowDays: 7,
      sinceIso: since7.toISOString(),
      users: { students, admins, newStudents7d },
      courses,
      enrollments: {
        total: enrollments,
        paid: paidEnrollments,
        unpaid: enrollments - paidEnrollments,
        completed: completedEnrollments,
        newLast7Days: newEnrollments7d,
      },
      quizzes: { total: quizzes, attemptsTotal, attemptsByStatus: toCountMap(attemptsByStatusRaw) },
      videos: { total: videosTotal, byStatus: toCountMap(videosByStatusRaw) },
      certificates,
      pendingWork: {
        attemptsAwaitingGrading: gradingAttempts,
        aiGradingJobsPending: pendingAiJobs,
        assignmentSubmissionsPending: submissionsPending,
      },
    };
  },
});

const platformRecentActivity = readTool({
  name: 'platform_recent_activity',
  description:
    'أحدث النشاط خلال نافذة زمنية محددة: أحدث الطلاب المسجّلين، وأحدث الاشتراكات، وأحدث محاولات الاختبارات، وأحدث المدفوعات، وأحدث العمليات الإدارية في سجل التدقيق. تُستخدم عند السؤال عمّا حدث اليوم أو خلال الأيام الأخيرة.',
  schema: z.object({
    windowDays: z.number().int().min(1).max(90).optional().describe('عدد الأيام للخلف، افتراضياً ٣٠'),
    take: z.number().int().min(1).max(25).optional().describe('عدد الصفوف في كل قسم، افتراضياً ٥'),
  }),
  cacheTtlSeconds: 15,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = Number.isSafeInteger(args.take) ? Math.max(1, Math.min(args.take, 25)) : 5;
    const since = daysAgo(args.windowDays);

    const [users, enrollments, attempts, payments, auditRows] = await Promise.all([
      prisma.user.findMany({
        // Phase 8 (FILTER): recent activity must not list a soft-deleted account.
        where: { createdAt: { gte: since }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take,
        select: { slug: true, name: true, email: true, grade: true, role: true, createdAt: true },
      }),
      prisma.enrollment.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          createdAt: true,
          isPaid: true,
          progress: true,
          user: { select: { slug: true, name: true, grade: true } },
          course: { select: { slug: true, title: true } },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { startedAt: { gte: since } },
        orderBy: { startedAt: 'desc' },
        take,
        select: {
          id: true,
          status: true,
          attemptNumber: true,
          scorePercent: true,
          startedAt: true,
          submittedAt: true,
          user: { select: { slug: true, name: true } },
          quiz: { select: { title: true, bunnyVideo: { select: { title: true } } } },
        },
      }),
      prisma.payment.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          createdAt: true,
          paidAt: true,
          user: { select: { slug: true, name: true } },
        },
      }),
      prisma.auditLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, action: true, actorId: true, targetType: true, targetId: true, createdAt: true },
      }),
    ]);

    return {
      windowDays: Number(args.windowDays),
      sinceIso: since.toISOString(),
      perSectionLimit: take,
      newUsers: users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
      newEnrollments: enrollments.map((e) => ({
        id: e.id,
        createdAt: e.createdAt.toISOString(),
        isPaid: e.isPaid,
        progress: e.progress,
        student: e.user,
        course: e.course,
      })),
      recentAttempts: attempts.map((a) => ({
        id: a.id,
        status: a.status,
        attemptNumber: a.attemptNumber,
        scorePercent: a.scorePercent,
        startedAt: a.startedAt.toISOString(),
        submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
        student: a.user,
        quizTitle: a.quiz ? a.quiz.title : null,
        videoTitle: a.quiz && a.quiz.bunnyVideo ? a.quiz.bunnyVideo.title : null,
      })),
      recentPayments: payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt ? p.paidAt.toISOString() : null,
        student: p.user,
      })),
      recentAdminActions: auditRows.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        targetType: r.targetType,
        targetId: r.targetId,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

module.exports = [platformOverview, platformRecentActivity];
