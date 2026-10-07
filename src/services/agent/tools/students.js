'use strict';

/**
 * students.js — student-domain read tools (read-only, Phase 1).
 *
 * Every fact is one bounded Prisma round-trip (count / groupBy / aggregate) so
 * cost does not grow with table size. The list tools are take-capped and
 * over-fetch by one row so `truncated` is PROVEN, never guessed.
 */

const { z } = require('zod');
const { readTool, clampTake, daysAgo } = require('./_kit');

/** Mirrors enum Grade in prisma/schema.prisma — kept local, no shared constants module exists. */
const GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
const ROLES = ['STUDENT', 'ADMIN'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date → ISO string, null-safe: no raw Date object ever leaves a tool payload. */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/** Average rounded to one decimal; null/undefined (no rows) becomes 0. */
function toAvg(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
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

const studentsCountByGrade = readTool({
  name: 'students_count_by_grade',
  description:
    'عدد المستخدمين موزّعين على الصفوف الدراسية (أولى/ثانية/ثالثة ثانوي) مع الإجمالي، مع إمكانية تحديد الدور (طالب أو مشرف). الحساب لحظي على كل الحسابات المسجّلة ولا يغطي نافذة زمنية.',
  schema: z.object({
    role: z.enum([...ROLES]).optional().describe('الدور المطلوب: STUDENT (الافتراضي) أو ADMIN'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const role = args.role || 'STUDENT';
    const grouped = await ctx.prisma.user.groupBy({
      by: ['grade'],
      _count: { _all: true },
      // Phase 8 (FILTER): a soft-deleted student must not be counted anywhere.
      where: { role, deletedAt: null },
    });

    const counts = new Map();
    let total = 0;
    for (const row of grouped) {
      counts.set(String(row.grade), row._count._all);
      total += row._count._all;
    }

    // A grade with zero users is reported as 0 so the answer can say "لا أحد" explicitly.
    const byGrade = GRADES.map((grade) => ({ grade, count: counts.get(grade) || 0 }));

    return { role, total, byGrade };
  },
});

const studentsNewTrend = readTool({
  name: 'students_new_trend',
  description:
    'اتجاه تسجيل الطلاب الجدد على آخر عدة فترات (أسابيع أو شهور). الشهر هنا نافذة ثابتة مدتها ٣٠ يومًا وليس شهرًا ميلاديًا. يُرجع لكل فترة تسميتها وبدايتها ونهايتها وعدد الطلاب المسجّلين فيها.',
  schema: z.object({
    granularity: z.enum(['week', 'month']).optional().describe('حجم الفترة: week (٧ أيام) أو month (٣٠ يومًا)'),
    periods: z.number().int().min(1).max(12).optional().describe('عدد الفترات الراجعة من الآن (١ إلى ١٢، الافتراضي ٤)'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const granularity = args.granularity || 'week';
    const periods = args.periods || 4;
    const buckets = buildBuckets(granularity, periods, new Date());

    // One count per bucket (≤12), each over [start, end) — never a row scan.
    const counts = await Promise.all(
      buckets.map((bucket) =>
        ctx.prisma.user.count({
          // Phase 8 (FILTER): a new-student trend must not count deleted accounts.
          where: { role: 'STUDENT', deletedAt: null, createdAt: { gte: bucket.start, lt: bucket.end } },
        })
      )
    );

    return {
      granularity,
      periods,
      buckets: buckets.map((bucket, index) => ({
        label: bucket.label,
        startIso: bucket.startIso,
        endIso: bucket.endIso,
        count: counts[index],
      })),
    };
  },
});

const studentSearch = readTool({
  name: 'student_search',
  description:
    'بحث مباشر (بدون تخزين مؤقت) عن المستخدمين بالاسم أو رقم الهاتف أو البريد الإلكتروني أو المعرّف العام (slug)، مع إمكانية التصفية بالصف الدراسي والدور. يُرجع أحدث الحسابات المنشأة حتى الحد المطلوب، ولا يغطي نافذة زمنية محددة.',
  schema: z.object({
    query: z.string().min(1).max(120).describe('نص البحث (اسم / هاتف / بريد / معرّف عام)'),
    grade: z.enum([...GRADES]).optional().describe('تصفية بالصف الدراسي'),
    role: z.enum([...ROLES]).optional().describe('تصفية بالدور: STUDENT أو ADMIN'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد نتائج (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 0,
  run: async (args, ctx) => {
    const take = clampTake(args.take, 25);
    const query = args.query.trim();

    const where = {
      // Phase 8 (FILTER): search must never surface a soft-deleted account. The
      // tombstoned email is skipped on purpose — matching deletedEmail here would
      // let a deleted student be found by the address the delete just freed.
      deletedAt: null,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { phoneNumber: { contains: query } },
        { email: { contains: query, mode: 'insensitive' } },
        { slug: { equals: query } },
      ],
      ...(args.grade ? { grade: args.grade } : {}),
      ...(args.role ? { role: args.role } : {}),
    };

    // take+1 is what makes `truncated` provable rather than a guess.
    const found = await ctx.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      select: {
        slug: true,
        name: true,
        email: true,
        phoneNumber: true,
        grade: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    const truncated = found.length > take;
    const rows = found.slice(0, take).map((user) => ({
      slug: user.slug,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      grade: user.grade,
      role: user.role,
      createdAt: toIso(user.createdAt),
      lastLoginAt: toIso(user.lastLoginAt),
    }));

    return { rows, returned: rows.length, truncated };
  },
});

const studentProfileSummary = readTool({
  name: 'student_profile_summary',
  description:
    'ملخّص طالب واحد بمعرّفه العام (slug): بياناته الأساسية، واشتراكاته (الإجمالي/المكتملة/المدفوعة/متوسط التقدم)، ومحاولات الاختبارات ومتوسط درجات المصحّح منها وآخر محاولة، وعدد الإعفاءات من بوابات الاختبار. كل الأرقام تراكمية من التسجيل حتى اللحظة وليست محدودة بنافذة زمنية.',
  schema: z.object({
    userSlug: z.string().min(3).max(64).describe('المعرّف العام للطالب (slug مثل u_xxxxxx)'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const user = await prisma.user.findFirst({
      // Phase 8 (FILTER): a soft-deleted student must not be reachable by the
      // agent's profile read — findFirst rather than findUnique because the extra
      // predicate is not part of a unique index.
      where: { slug: args.userSlug, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        phoneNumber: true,
        grade: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) return { found: false };

    const userId = user.id;
    const [enrollmentCount, completedCount, progressAgg, paidCount, attempts, scoreAgg, latestAttempt, exemptions] =
      await Promise.all([
        prisma.enrollment.count({ where: { userId } }),
        prisma.enrollment.count({ where: { userId, isCompleted: true } }),
        prisma.enrollment.aggregate({ where: { userId }, _avg: { progress: true } }),
        prisma.enrollment.count({ where: { userId, isPaid: true } }),
        prisma.quizAttempt.count({ where: { userId } }),
        prisma.quizAttempt.aggregate({ where: { userId, status: 'GRADED' }, _avg: { scorePercent: true } }),
        prisma.quizAttempt.findFirst({
          where: { userId },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true },
        }),
        prisma.gateExemption.count({ where: { userId } }),
      ]);

    return {
      found: true,
      student: {
        slug: user.slug,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        grade: user.grade,
        role: user.role,
        createdAt: toIso(user.createdAt),
        lastLoginAt: toIso(user.lastLoginAt),
      },
      enrollments: {
        total: enrollmentCount,
        completed: completedCount,
        paid: paidCount,
        avgProgress: toAvg(progressAgg._avg.progress),
      },
      quizzes: {
        attempts,
        // null (not 0) when nothing was graded yet — a 0 would read as "student scored zero".
        avgScore: scoreAgg._avg.scorePercent == null ? null : toAvg(scoreAgg._avg.scorePercent),
        lastAttemptAtIso: toIso(latestAttempt && latestAttempt.startedAt),
      },
      gateExemptions: exemptions,
    };
  },
});

const studentPerformanceRanking = readTool({
  name: 'student_performance_ranking',
  description:
    'ترتيب الطلاب حسب متوسط درجاتهم في محاولات الاختبارات المصحّحة (GRADED)، من الأعلى أو من الأدنى، مع حد أدنى لعدد المحاولات وإمكانية التصفية بالصف الدراسي. الحساب تراكمي على كل المحاولات المسجّلة وليس على نافذة زمنية.',
  schema: z.object({
    direction: z.enum(['top', 'bottom']).optional().describe('top للأعلى (الافتراضي) أو bottom للأدنى'),
    grade: z.enum([...GRADES]).optional().describe('تصفية بالصف الدراسي'),
    minAttempts: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('أقل عدد محاولات مصحّحة لقبول الطالب في الترتيب (الافتراضي ٢)'),
    take: z.number().int().min(1).max(25).optional().describe('عدد الطلاب في النتيجة (١ إلى ٢٥، الافتراضي ١٠)'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const direction = args.direction || 'top';
    const minAttempts = args.minAttempts || 2;
    const take = clampTake(args.take, 10);

    const grouped = await prisma.quizAttempt.groupBy({
      by: ['userId'],
      where: { status: 'GRADED', ...(args.grade ? { user: { grade: args.grade } } : {}) },
      _avg: { scorePercent: true },
      _count: { _all: true },
      orderBy: { _avg: { scorePercent: direction === 'bottom' ? 'asc' : 'desc' } },
    });

    const eligible = grouped.filter((row) => row._count._all >= minAttempts);
    const page = eligible.slice(0, take);

    // groupBy cannot join User, so names come from ONE follow-up findMany keyed by id.
    const users = page.length
      ? await prisma.user.findMany({
          // Phase 8 (FILTER): names come back only for rows that still exist —
          // a soft-deleted student drops out of the ranking instead of being
          // rendered with a placeholder.
          where: { id: { in: page.map((row) => row.userId) }, deletedAt: null },
          select: { id: true, slug: true, name: true, grade: true },
        })
      : [];
    const byId = new Map(users.map((user) => [user.id, user]));

    // A userId deleted between the two queries is skipped, never faked with a placeholder.
    const rows = page
      .filter((row) => byId.has(row.userId))
      .map((row) => {
        const user = byId.get(row.userId);
        return {
          name: user.name,
          slug: user.slug,
          grade: user.grade,
          avgScore: toAvg(row._avg.scorePercent),
          attempts: row._count._all,
        };
      });

    return { direction, minAttempts, rows, returned: rows.length, truncated: eligible.length > take };
  },
});

const inactiveStudents = readTool({
  name: 'inactive_students',
  description:
    'اشتراكات لم يتفاعل معها أصحابها ولم يكملوا الدورة: آخر تفاعل (lastAccess) أقدم من عدد الأيام المحدد، مرتبة من الأقدم تفاعلًا إلى الأحدث. النافذة هي آخر عدد الأيام المنتهية الآن.',
  schema: z.object({
    inactiveDays: z.number().int().min(1).max(365).optional().describe('عدد أيام الخمول (١ إلى ٣٦٥، الافتراضي ١٤)'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد صفوف (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 15,
  run: async (args, ctx) => {
    const inactiveDays = args.inactiveDays || 14;
    const take = clampTake(args.take, 25);
    const cutoff = daysAgo(inactiveDays);

    const found = await ctx.prisma.enrollment.findMany({
      where: { lastAccess: { lt: cutoff }, isCompleted: false },
      orderBy: { lastAccess: 'asc' },
      take: take + 1,
      include: {
        user: { select: { slug: true, name: true, email: true, phoneNumber: true, grade: true } },
        course: { select: { slug: true, title: true, grade: true } },
      },
    });

    const truncated = found.length > take;
    const rows = found.slice(0, take).map((enrollment) => ({
      student: enrollment.user,
      course: enrollment.course,
      progress: enrollment.progress,
      lastAccessIso: toIso(enrollment.lastAccess),
    }));

    return { inactiveDays, cutoffIso: cutoff.toISOString(), rows, returned: rows.length, truncated };
  },
});

module.exports = [
  studentsCountByGrade,
  studentsNewTrend,
  studentSearch,
  studentProfileSummary,
  studentPerformanceRanking,
  inactiveStudents,
];
