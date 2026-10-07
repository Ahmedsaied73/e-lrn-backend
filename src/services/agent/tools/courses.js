'use strict';

/**
 * courses.js — course-domain read tools (read-only, Phase 1).
 *
 * Every fact is one bounded Prisma count/groupBy/aggregate; list tools over-fetch
 * by one row so `truncated` is PROVEN rather than guessed. `readyVideos` and the
 * per-grade enrollment rollup need a JOIN or a column-to-column comparison Prisma
 * cannot express, so those two are resolved with one extra grouped read merged in
 * JS (never per-row).
 */

const { z } = require('zod');
const { readTool, clampTake } = require('./_kit');

/** Mirrors enum Grade in prisma/schema.prisma — kept local, no shared constants module exists. */
const GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
const VIDEO_STATUSES = ['PENDING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED'];

/** Date → ISO string, null-safe: no raw Date object ever leaves a tool payload. */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/** One decimal, null/undefined → 0. Used for every average/percentage returned. */
function oneDecimal(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
}

/** Share of `part` in `whole` as a one-decimal percentage; 0 when whole is 0. */
function percentage(part, whole) {
  return whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0;
}

const coursesList = readTool({
  name: 'courses_list',
  description:
    'قائمة الدورات (بلا نافذة زمنية) مع الصف الدراسي والتصنيف والسعر بالجنيه وتاريخ الإنشاء، وعدد المشتركين وعدد فيديوهات باني الإجمالي والجاهز منها، ويمكن الترتيب بالأحدث أو الأكثر اشتراكًا وحصر النتائج في صف دراسي واحد.',
  schema: z.object({
    grade: z.enum([...GRADES]).optional().describe('الصف الدراسي: FIRST_SECONDARY أو SECOND_SECONDARY أو THIRD_SECONDARY'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الدورات في النتيجة (١ إلى ٥٠، الافتراضي ٢٥)'),
    orderBy: z.enum(['newest', 'enrollments']).optional().describe('الترتيب: newest (الأحدث إنشاءً) أو enrollments (الأكثر اشتراكًا)'),
  }),
  cacheTtlSeconds: 45,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 25);
    const order = args.orderBy || 'newest';

    // `id` as the final tie-break keeps the page deterministic when rows were
    // created in the same millisecond or share an enrollment count.
    const orderBy =
      order === 'enrollments'
        ? [{ enrollments: { _count: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }];

    const found = await prisma.course.findMany({
      // Phase 8 (FILTER): a soft-deleted course is hidden from every agent read.
      where: args.grade ? { grade: args.grade, deletedAt: null } : { deletedAt: null },
      orderBy,
      take: take + 1,
      select: {
        id: true,
        slug: true,
        title: true,
        grade: true,
        category: true,
        price: true,
        createdAt: true,
        _count: { select: { enrollments: true, bunnyVideos: true } },
      },
    });

    const truncated = found.length > take;
    const page = found.slice(0, take);

    // READY videos per course: one grouped read for the whole page, never a
    // count-per-course loop.
    const readyByCourse = new Map();
    if (page.length > 0) {
      const grouped = await prisma.bunnyVideo.groupBy({
        by: ['courseId'],
        where: { courseId: { in: page.map((course) => course.id) }, status: 'READY' },
        _count: { _all: true },
      });
      for (const row of grouped) readyByCourse.set(row.courseId, row._count._all);
    }

    const rows = page.map((course) => ({
      courseSlug: course.slug,
      title: course.title,
      grade: course.grade,
      category: course.category,
      priceEgp: course.price,
      createdAtIso: toIso(course.createdAt),
      enrollments: course._count.enrollments,
      videos: course._count.bunnyVideos,
      readyVideos: readyByCourse.get(course.id) || 0,
    }));

    return { grade: args.grade || null, orderBy: order, rows, returned: rows.length, truncated };
  },
});

const courseDetail = readTool({
  name: 'course_detail',
  description:
    'تفاصيل دورة واحدة بمعرّفها (slug) وبلا نافذة زمنية: الصف والتصنيف والسعر وتاريخ الإنشاء، وعدد المشتركين والمدفوعين والمكتملين ومتوسط التقدّم، وعدد فيديوهات باني الإجمالي والجاهز، وعدد الاختبارات والشهادات، وعدد المدفوعات المكتملة وإجمالي مبلغها بالجنيه. إذا كان المعرّف غير معروف يُرجع found=false.',
  schema: z.object({
    courseSlug: z.string().min(1).describe('معرّف الدورة (slug) المطلوب تفاصيله'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;

    const course = await prisma.course.findFirst({
      // Phase 8 (FILTER): a soft-deleted course reads as "not found" to the agent.
      where: { slug: args.courseSlug, deletedAt: null },
      select: { id: true, slug: true, title: true, grade: true, category: true, price: true, createdAt: true },
    });
    if (!course) return { found: false, courseSlug: args.courseSlug };

    const courseId = course.id;
    const [enrollments, paid, completed, progressAgg, videos, readyVideos, quizzes, certificates, paymentsAgg] =
      await Promise.all([
        prisma.enrollment.count({ where: { courseId } }),
        prisma.enrollment.count({ where: { courseId, isPaid: true } }),
        prisma.enrollment.count({ where: { courseId, isCompleted: true } }),
        prisma.enrollment.aggregate({ where: { courseId }, _avg: { progress: true } }),
        prisma.bunnyVideo.count({ where: { courseId } }),
        prisma.bunnyVideo.count({ where: { courseId, status: 'READY' } }),
        // Quizzes hang off the video, not the course — hence the relation filter.
        prisma.quiz.count({ where: { bunnyVideo: { courseId } } }),
        prisma.certificate.count({ where: { courseId } }),
        prisma.payment.aggregate({
          where: { courseId, status: 'COMPLETED' },
          _sum: { amount: true },
          _count: { _all: true },
        }),
      ]);

    return {
      found: true,
      courseSlug: course.slug,
      title: course.title,
      grade: course.grade,
      category: course.category,
      priceEgp: course.price,
      createdAtIso: toIso(course.createdAt),
      enrollments: {
        total: enrollments,
        paid,
        completed,
        avgProgress: oneDecimal(progressAgg._avg.progress),
      },
      videos: { total: videos, ready: readyVideos },
      quizzes,
      certificates,
      payments: { completed: paymentsAgg._count._all, amountEgp: paymentsAgg._sum.amount || 0 },
    };
  },
});

const courseCompletionRates = readTool({
  name: 'course_completion_rates',
  description:
    'نسب إكمال الدورات بلا نافذة زمنية، مع إمكانية حصر النتائج في صف دراسي واحد: لكل دورة عدد المشتركين وعدد من أكملها ونسبة الإكمال ومتوسط التقدّم، مرتبة من الأعلى نسبة إكمال إلى الأدنى. الدورات التي لا مشتركين لها لا تظهر لأن نسبة الإكمال بلا معنى فيها.',
  schema: z.object({
    grade: z.enum([...GRADES]).optional().describe('الصف الدراسي: FIRST_SECONDARY أو SECOND_SECONDARY أو THIRD_SECONDARY'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الدورات في النتيجة (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  cacheTtlSeconds: 45,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 25);

    const courses = await prisma.course.findMany({
      where: args.grade ? { grade: args.grade, deletedAt: null } : { deletedAt: null },
      select: { id: true, slug: true, title: true, grade: true },
    });
    if (courses.length === 0) return { grade: args.grade || null, rows: [], returned: 0, truncated: false };

    const courseIds = courses.map((course) => course.id);
    const [totals, completedRows] = await Promise.all([
      prisma.enrollment.groupBy({
        by: ['courseId'],
        where: { courseId: { in: courseIds } },
        _count: { _all: true },
        _avg: { progress: true },
      }),
      prisma.enrollment.groupBy({
        by: ['courseId'],
        where: { courseId: { in: courseIds }, isCompleted: true },
        _count: { _all: true },
      }),
    ]);

    const completedByCourse = new Map(completedRows.map((row) => [row.courseId, row._count._all]));
    const courseById = new Map(courses.map((course) => [course.id, course]));

    const all = [];
    for (const row of totals) {
      const course = courseById.get(row.courseId);
      // An enrollment pointing at a deleted course cannot happen (FK cascade), so
      // this is a pure safety net rather than an expected branch.
      if (!course) continue;
      const enrollments = row._count._all;
      const completed = completedByCourse.get(row.courseId) || 0;
      all.push({
        courseSlug: course.slug,
        title: course.title,
        grade: course.grade,
        enrollments,
        completed,
        completionRate: percentage(completed, enrollments),
        avgProgress: oneDecimal(row._avg.progress),
      });
    }

    all.sort((a, b) => b.completionRate - a.completionRate || b.enrollments - a.enrollments);
    const rows = all.slice(0, take);

    return {
      grade: args.grade || null,
      rows,
      returned: rows.length,
      truncated: all.length > take,
    };
  },
});

const coursesByGrade = readTool({
  name: 'courses_by_grade',
  description:
    'توزيع الدورات على الصفوف الدراسية بلا نافذة زمنية: لكل صف عدد الدورات وعدد الاشتراكات فيها ومتوسط سعر الدورة بالجنيه، بترتيب الصفوف من الأولى إلى الثالثة ثانوي.',
  schema: z.object({}),
  cacheTtlSeconds: 60,
  run: async (_args, ctx) => {
    const prisma = ctx.prisma;

    const [grouped, courses, enrollmentGroups] = await Promise.all([
      // Phase 8 (FILTER): deleted courses are excluded from every rollup.
      prisma.course.groupBy({
        by: ['grade'],
        _count: { _all: true },
        _avg: { price: true },
        where: { deletedAt: null },
      }),
      // Enrollment rows carry a courseId, not a grade — the grade mapping arrives
      // with the courses and the rollup happens in JS, never as an N+1 query.
      prisma.course.findMany({ where: { deletedAt: null }, select: { id: true, grade: true } }),
      prisma.enrollment.groupBy({ by: ['courseId'], _count: { _all: true } }),
    ]);

    const gradeByCourse = new Map(courses.map((course) => [course.id, course.grade]));
    const enrollmentsByGrade = new Map();
    for (const row of enrollmentGroups) {
      const grade = gradeByCourse.get(row.courseId);
      if (!grade) continue;
      enrollmentsByGrade.set(grade, (enrollmentsByGrade.get(grade) || 0) + row._count._all);
    }

    const groupedByGrade = new Map(grouped.map((row) => [String(row.grade), row]));
    const byGrade = GRADES.map((grade) => {
      const row = groupedByGrade.get(grade);
      return {
        grade,
        courses: row ? row._count._all : 0,
        enrollments: enrollmentsByGrade.get(grade) || 0,
        avgPriceEgp: row ? oneDecimal(row._avg.price) : 0,
      };
    });

    return { byGrade };
  },
});

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

const videoPipelineStatus = readTool({
  name: 'video_pipeline_status',
  description:
    'حالة خط معالجة فيديوهات باني في هذه اللحظة (بلا نافذة زمنية): عدد الفيديوهات حسب حالة المعالجة (PENDING/UPLOADING/PROCESSING/READY/FAILED)، وعدد الفيديوهات العالقة في PROCESSING أطول من الحد المحدد بالدقائق مع قائمة أقدمها، وقائمة أحدث الفيديوهات الفاشلة مع سبب الفشل والدورة التابعة لها.',
  schema: z.object({
    staleMinutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .optional()
      .describe('عدد الدقائق التي بعدها يُعد فيديو PROCESSING عالقًا (٥ إلى ١٤٤٠، الافتراضي ٣٠)'),
    take: z.number().int().min(1).max(50).optional().describe('أقصى عدد صفوف في كل قائمة (١ إلى ٥٠، الافتراضي ٢٠)'),
  }),
  cacheTtlSeconds: 15,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const staleMinutes = args.staleMinutes || 30;
    const take = clampTake(args.take, 20);
    const now = Date.now();
    const staleBefore = new Date(now - staleMinutes * 60 * 1000);

    const [byStatusRaw, stuckFound, failedFound, stuckCount] = await Promise.all([
      prisma.bunnyVideo.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bunnyVideo.findMany({
        where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        orderBy: { updatedAt: 'asc' },
        take: take + 1,
        select: {
          id: true,
          title: true,
          slug: true,
          processingProgress: true,
          updatedAt: true,
          course: { select: { slug: true, title: true } },
        },
      }),
      prisma.bunnyVideo.findMany({
        where: { status: 'FAILED' },
        orderBy: { updatedAt: 'desc' },
        take: take + 1,
        select: {
          id: true,
          title: true,
          slug: true,
          failureReason: true,
          course: { select: { slug: true, title: true } },
        },
      }),
      // Exact backlog size, independent of the page size used for the row list.
      prisma.bunnyVideo.count({ where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } } }),
    ]);

    const stuckRows = stuckFound.slice(0, take).map((video) => ({
      id: video.id,
      title: video.title,
      slug: video.slug,
      processingProgress: video.processingProgress,
      stuckMinutes: Math.floor((now - video.updatedAt.getTime()) / 60000),
      updatedAtIso: toIso(video.updatedAt),
      courseSlug: video.course ? video.course.slug : null,
      courseTitle: video.course ? video.course.title : null,
    }));

    const failedRows = failedFound.slice(0, take).map((video) => ({
      id: video.id,
      title: video.title,
      slug: video.slug,
      failureReason: video.failureReason,
      courseSlug: video.course ? video.course.slug : null,
      courseTitle: video.course ? video.course.title : null,
    }));

    return {
      byStatus: toCountMap(byStatusRaw, VIDEO_STATUSES),
      staleMinutes,
      staleCutoffIso: staleBefore.toISOString(),
      stuckCount,
      stuck: { rows: stuckRows, returned: stuckRows.length, truncated: stuckFound.length > take },
      failed: { rows: failedRows, returned: failedRows.length, truncated: failedFound.length > take },
    };
  },
});

const videoEngagement = readTool({
  name: 'video_engagement',
  description:
    'تفاعل الطلاب مع الفيديوهات: عدد المشاهدين، وعدد من أكمل المشاهدة، ونسبة الإكمال لكل فيديو (واختيارياً داخل دورة محددة)، مرتبةً حسب عدد المشاهدات. تُستخدم عند السؤال عن الفيديوهات الأكثر مشاهدة أو عن نسب إكمال المشاهدة.',
  schema: z.object({
    courseSlug: z.string().min(3).max(64).optional().describe('معرّف الدورة لتضييق النتائج على دورة واحدة'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الفيديوهات، افتراضياً ٢٥'),
  }),
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const take = clampTake(args.take, 25);
    const rate = (completed, viewers) => (viewers ? Number(((completed / viewers) * 100).toFixed(1)) : 0);

    let courseId = null;
    if (args.courseSlug) {
      const course = await prisma.course.findFirst({
        where: { slug: args.courseSlug, deletedAt: null },
        select: { id: true },
      });
      if (!course) return { found: false, courseSlug: args.courseSlug };
      courseId = course.id;
    }

    const baseWhere = courseId ? { bunnyVideo: { courseId } } : {};

    const [viewersRaw, completedRaw, totalViewers, totalCompleted] = await Promise.all([
      prisma.bunnyVideoProgress.groupBy({ by: ['bunnyVideoId'], where: baseWhere, _count: { _all: true } }),
      prisma.bunnyVideoProgress.groupBy({
        by: ['bunnyVideoId'],
        where: { ...baseWhere, completed: true },
        _count: { _all: true },
      }),
      prisma.bunnyVideoProgress.count({ where: baseWhere }),
      prisma.bunnyVideoProgress.count({ where: { ...baseWhere, completed: true } }),
    ]);

    const completedByVideo = new Map(completedRaw.map((row) => [row.bunnyVideoId, row._count._all]));
    const ranked = viewersRaw
      .map((row) => ({
        bunnyVideoId: row.bunnyVideoId,
        viewers: row._count._all,
        completed: completedByVideo.get(row.bunnyVideoId) || 0,
      }))
      .sort((a, b) => b.viewers - a.viewers)
      .slice(0, take);

    // One lookup for the page, never a query per row.
    const videos = ranked.length
      ? await prisma.bunnyVideo.findMany({
          where: { id: { in: ranked.map((row) => row.bunnyVideoId) } },
          select: { id: true, slug: true, title: true, course: { select: { slug: true, title: true } } },
        })
      : [];
    const byId = new Map(videos.map((video) => [video.id, video]));

    const rows = ranked
      .filter((row) => byId.has(row.bunnyVideoId))
      .map((row) => {
        const video = byId.get(row.bunnyVideoId);
        return {
          videoSlug: video.slug,
          videoTitle: video.title,
          courseSlug: video.course ? video.course.slug : null,
          courseTitle: video.course ? video.course.title : null,
          viewers: row.viewers,
          completed: row.completed,
          completionRate: rate(row.completed, row.viewers),
        };
      });

    return {
      found: true,
      courseSlug: args.courseSlug || null,
      overall: { viewers: totalViewers, completed: totalCompleted, completionRate: rate(totalCompleted, totalViewers) },
      rows,
      returned: rows.length,
      truncated: viewersRaw.length > take,
    };
  },
});

module.exports = [
  coursesList,
  courseDetail,
  courseCompletionRates,
  coursesByGrade,
  videoPipelineStatus,
  videoEngagement,
];
