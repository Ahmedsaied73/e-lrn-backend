'use strict';

/**
 * enrollments.js — enrollment / revenue read tools (read-only, Phase 1).
 *
 * Aggregates only: every tool is a bounded set of count / groupBy / aggregate
 * calls (≤12 queries, one per bucket or per metric) plus, for the two list
 * tools, a take-capped findMany that over-fetches one row to prove truncation.
 * No raw SQL, no relation loading beyond small explicit selects.
 */

const { z } = require('zod');
const { readTool, clampTake, daysAgo } = require('./_kit');

/** Mirrors enum Grade in prisma/schema.prisma — kept local, no shared constants module exists. */
const GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
/** Mirrors enum PaymentStatus (prisma/schema.prisma) so byStatus is stable for every window. */
const PAYMENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date → ISO string, null-safe: no raw Date object ever leaves a tool payload. */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/** Average/percentage rounded to one decimal; null/undefined (no rows) becomes 0. */
function toAvg(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
}

/** Computed percentage, one decimal, divide-by-zero safe. */
function toPercent(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

/**
 * `periods` consecutive buckets ending at `now`, oldest first. A "month" bucket
 * is a fixed 30-day window, NOT a calendar month — the label states the exact
 * range so the answer layer can never claim otherwise.
 */
function buildBuckets(granularity, periods, now) {
  const unitMs = (granularity === 'month' ? 30 : 7) * DAY_MS;
  const buckets = [];
  for (let i = periods - 1; i >= 0; i -= 1) {
    const end = new Date(now.getTime() - i * unitMs);
    const start = new Date(end.getTime() - unitMs);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    buckets.push({ label: `${startIso.slice(0, 10)}..${endIso.slice(0, 10)}`, startIso, endIso, start, end });
  }
  return buckets;
}

const enrollmentStats = readTool({
  name: 'enrollment_stats',
  description:
    'إحصاءات الاشتراكات: الإجمالي، المدفوعة، غير المدفوعة، المكتملة، والجديد والمكتمل خلال نافذة زمنية محددة (بناءً على تاريخ الإنشاء وتاريخ الإكمال)، مع متوسط نسبة التقدم. يمكن حصر النتيجة على دورة واحدة بالمعرّف العام أو على صف دراسي.',
  schema: z.object({
    courseSlug: z.string().optional().describe('المعرّف العام للدورة (slug) لحصر النتيجة على دورة واحدة'),
    grade: z.enum([...GRADES]).optional().describe('تصفية بالصف الدراسي للدورة'),
    windowDays: z.number().int().min(1).max(365).optional().describe('طول النافذة الزمنية بالأيام (الافتراضي ٣٠)'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const windowDays = args.windowDays || 30;
    const since = daysAgo(windowDays);

    let courseId = null;
    if (args.courseSlug) {
      const course = await prisma.course.findFirst({
        // Phase 8 (FILTER): a soft-deleted course reports as not found.
        where: { slug: args.courseSlug, deletedAt: null },
        select: { id: true },
      });
      // Unknown slug is an answer ("الدورة غير موجودة"), not an error.
      if (!course) return { found: false, courseSlug: args.courseSlug };
      courseId = course.id;
    }

    const where = {
      ...(courseId === null ? {} : { courseId }),
      ...(args.grade ? { course: { grade: args.grade } } : {}),
    };

    const [total, paid, unpaid, completed, newInWindow, completedInWindow, progressAgg] = await Promise.all([
      prisma.enrollment.count({ where }),
      prisma.enrollment.count({ where: { ...where, isPaid: true } }),
      prisma.enrollment.count({ where: { ...where, isPaid: false } }),
      prisma.enrollment.count({ where: { ...where, isCompleted: true } }),
      prisma.enrollment.count({ where: { ...where, createdAt: { gte: since } } }),
      prisma.enrollment.count({ where: { ...where, isCompleted: true, completedAt: { gte: since } } }),
      prisma.enrollment.aggregate({ where, _avg: { progress: true } }),
    ]);

    return {
      found: true,
      windowDays,
      sinceIso: since.toISOString(),
      total,
      paid,
      unpaid,
      completed,
      newInWindow,
      completedInWindow,
      avgProgress: toAvg(progressAgg._avg.progress),
    };
  },
});

const enrollmentTrend = readTool({
  name: 'enrollment_trend',
  description:
    'اتجاه الاشتراكات الجديدة على آخر عدة فترات (أسابيع أو شهور)، مع تفصيل المدفوع وغير المدفوع في كل فترة. الشهر هنا نافذة ثابتة مدتها ٣٠ يومًا وليس شهرًا ميلاديًا، والفترة تُحسب من تاريخ إنشاء الاشتراك.',
  schema: z.object({
    granularity: z.enum(['week', 'month']).optional().describe('حجم الفترة: week (٧ أيام) أو month (٣٠ يومًا)'),
    periods: z.number().int().min(1).max(12).optional().describe('عدد الفترات الراجعة من الآن (١ إلى ١٢، الافتراضي ٤)'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const granularity = args.granularity || 'week';
    const periods = args.periods || 4;
    const buckets = buildBuckets(granularity, periods, new Date());

    // One groupBy per bucket (≤12); the paid/unpaid split rides on the group key.
    const grouped = await Promise.all(
      buckets.map((bucket) =>
        ctx.prisma.enrollment.groupBy({
          by: ['isPaid'],
          where: { createdAt: { gte: bucket.start, lt: bucket.end } },
          _count: { _all: true },
        })
      )
    );

    return {
      granularity,
      periods,
      buckets: buckets.map((bucket, index) => {
        let paid = 0;
        let unpaid = 0;
        for (const row of grouped[index]) {
          if (row.isPaid) paid += row._count._all;
          else unpaid += row._count._all;
        }
        return {
          label: bucket.label,
          startIso: bucket.startIso,
          endIso: bucket.endIso,
          total: paid + unpaid,
          paid,
          unpaid,
        };
      }),
    };
  },
});

const enrollmentByCourse = readTool({
  name: 'enrollment_by_course',
  description:
    'جدول الدورة الواحدة: عدد الاشتراكات، والمكتملة، ونسبة الإكمال، ومتوسط التقدم، وإجمالي الإيرادات المحصّلة (المدفوعات المكتملة فقط) وعددها. النتيجة لكل الدورات أو لدورات صف دراسي واحد، مرتبة من الأقدم إنشاءً. الإيرادات والمقارنات تراكمية وليست محدودة بنافذة زمنية.',
  schema: z.object({
    grade: z.enum([...GRADES]).optional().describe('تصفية بالصف الدراسي للدورة'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد دورات (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 45,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 25);

    const found = await prisma.course.findMany({
      where: args.grade ? { grade: args.grade, deletedAt: null } : { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: take + 1,
      select: { id: true, slug: true, title: true, grade: true, price: true },
    });
    const truncated = found.length > take;
    const courses = found.slice(0, take);
    const ids = courses.map((course) => course.id);
    if (ids.length === 0) return { rows: [], returned: 0, truncated };

    // Four keyed aggregates for the whole page of courses — no per-course query.
    const [totalGroups, completedGroups, progressGroups, paymentGroups] = await Promise.all([
      prisma.enrollment.groupBy({ by: ['courseId'], where: { courseId: { in: ids } }, _count: { _all: true } }),
      prisma.enrollment.groupBy({
        by: ['courseId'],
        where: { courseId: { in: ids }, isCompleted: true },
        _count: { _all: true },
      }),
      prisma.enrollment.groupBy({ by: ['courseId'], where: { courseId: { in: ids } }, _avg: { progress: true } }),
      prisma.payment.groupBy({
        by: ['courseId'],
        where: { courseId: { in: ids }, status: 'COMPLETED' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const totalByCourse = new Map(totalGroups.map((row) => [row.courseId, row._count._all]));
    const completedByCourse = new Map(completedGroups.map((row) => [row.courseId, row._count._all]));
    const progressByCourse = new Map(progressGroups.map((row) => [row.courseId, row._avg.progress]));
    const paymentsByCourse = new Map(paymentGroups.map((row) => [row.courseId, row]));

    const rows = courses.map((course) => {
      const enrollmentCount = totalByCourse.get(course.id) || 0;
      const completed = completedByCourse.get(course.id) || 0;
      const payment = paymentsByCourse.get(course.id);
      return {
        courseSlug: course.slug,
        title: course.title,
        grade: course.grade,
        priceEgp: course.price,
        enrollments: enrollmentCount,
        completed,
        completionRate: toPercent(completed, enrollmentCount),
        avgProgress: toAvg(progressByCourse.get(course.id)),
        revenueEgp: (payment && payment._sum.amount) || 0,
        paymentsCount: payment ? payment._count._all : 0,
      };
    });

    return { rows, returned: rows.length, truncated };
  },
});

const revenueSummary = readTool({
  name: 'revenue_summary',
  description:
    'ملخّص الإيرادات خلال نافذة زمنية محددة (حسب تاريخ إنشاء عملية الدفع): عدد ومبالغ العمليات لكل حالة (مدفوع/مسترجع/فاشل/معلّق/منتهي)، وإجمالي الإيرادات المحصّلة والمبالغ المسترجعة وعدد العمليات، ومتوسط قيمة العملية المكتملة. المبالغ بالجنيه المصري كأرقام صحيحة.',
  schema: z.object({
    windowDays: z.number().int().min(1).max(365).optional().describe('طول النافذة الزمنية بالأيام (الافتراضي ٣٠)'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const windowDays = args.windowDays || 30;
    const since = daysAgo(windowDays);

    const grouped = await ctx.prisma.payment.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amount: true },
    });

    // Every status is reported, zeroed when absent, so the answer never has to guess.
    const byStatus = {};
    for (const status of PAYMENT_STATUSES) byStatus[status] = { count: 0, amount: 0 };
    for (const row of grouped) {
      byStatus[String(row.status)] = { count: row._count._all, amount: row._sum.amount || 0 };
    }

    const completedCount = byStatus.COMPLETED.count;
    const revenueEgp = byStatus.COMPLETED.amount;

    return {
      windowDays,
      sinceIso: since.toISOString(),
      currency: 'EGP',
      note: 'المبالغ بالجنيه المصري كأرقام صحيحة',
      byStatus,
      revenueEgp,
      refundedEgp: byStatus.REFUNDED.amount,
      completedCount,
      refundedCount: byStatus.REFUNDED.count,
      failedCount: byStatus.FAILED.count,
      pendingCount: byStatus.PENDING.count,
      avgOrderValueEgp: completedCount > 0 ? Number((revenueEgp / completedCount).toFixed(1)) : 0,
    };
  },
});

// Exact audit literals written by src/services/payments/paymentService.js (grep-verified):
// PAYMENT_AMOUNT_MISMATCH (line 346), PAYMENT_DUPLICATE_CHARGE (420), PAYMENT_COMPLETED (445).
const PAYMENT_FLAG_ACTIONS = ['PAYMENT_AMOUNT_MISMATCH', 'PAYMENT_DUPLICATE_CHARGE', 'PAYMENT_COMPLETED'];
const PAYMENT_ISSUE_STATUSES = ['FAILED', 'EXPIRED'];

const paymentIssues = readTool({
  name: 'payment_issues',
  description:
    'مشاكل الدفع خلال نافذة زمنية محددة: عمليات الدفع الفاشلة أو المنتهية (غير المكتملة) مرتبة من الأحدث، وسجل الرقابة الخاص بمشاكل الدفع (عدم تطابق المبلغ، تحصيل مكرر، وعمليات الدفع المكتملة) للتحقق اليدوي.',
  schema: z.object({
    windowDays: z.number().int().min(1).max(365).optional().describe('طول النافذة الزمنية بالأيام (الافتراضي ٣٠)'),
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
    const windowDays = args.windowDays || 30;
    const take = clampTake(args.take, 20);
    const since = daysAgo(windowDays);

    const [payments, flags] = await Promise.all([
      prisma.payment.findMany({
        where: { status: { in: PAYMENT_ISSUE_STATUSES }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          failureReason: true,
          createdAt: true,
          userId: true,
          courseId: true,
        },
      }),
      prisma.auditLog.findMany({
        where: { action: { in: PAYMENT_FLAG_ACTIONS }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        select: { id: true, action: true, targetType: true, targetId: true, actorId: true, createdAt: true },
      }),
    ]);

    // `metadata` is deliberately NOT selected: it can carry raw provider payloads.
    const paymentRows = payments.slice(0, take).map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      failureReason: payment.failureReason,
      userId: payment.userId,
      courseId: payment.courseId,
      createdAtIso: toIso(payment.createdAt),
    }));

    const auditRows = flags.slice(0, take).map((flag) => ({
      id: flag.id,
      action: flag.action,
      targetType: flag.targetType,
      targetId: flag.targetId,
      actorId: flag.actorId,
      createdAtIso: toIso(flag.createdAt),
    }));

    return {
      windowDays,
      sinceIso: since.toISOString(),
      failedOrExpired: { rows: paymentRows, returned: paymentRows.length, truncated: payments.length > take },
      auditFlags: { rows: auditRows, returned: auditRows.length, truncated: flags.length > take },
    };
  },
});

module.exports = [enrollmentStats, enrollmentTrend, enrollmentByCourse, revenueSummary, paymentIssues];
