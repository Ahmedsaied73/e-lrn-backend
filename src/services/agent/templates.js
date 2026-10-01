'use strict';

/**
 * templates.js — deterministic Arabic answers (Phase 2).
 *
 * The fast path never lets a model write prose: numbers come from a tool (already
 * capped, cached and PII-redacted) and this module turns that payload into Arabic
 * Markdown. Consequences that matter:
 *  - NO arithmetic on business numbers here, only formatting. If a template ever
 *    computes a figure, that figure stops being traceable to a tool.
 *  - Every answer states its TIME WINDOW and admits truncation/sampling, because
 *    "12 payment failure" without a window is a different claim than with one.
 *  - Percent values arrive already on a 0..100 scale (the tools do the maths);
 *    the single exception is AI confidence, which is 0..1 and is labelled as such.
 *
 * Times are rendered in Africa/Cairo (the platform's audience: EGP, Arabic) and
 * always as "YYYY-MM-DD HH:mm" so they are unambiguous and testable.
 */

const DISPLAY_TIME_ZONE = 'Africa/Cairo';

const GRADE_LABELS = {
  FIRST_SECONDARY: 'أولى ثانوي',
  SECOND_SECONDARY: 'تانية ثانوي',
  THIRD_SECONDARY: 'تالتة ثانوي',
};

const STATUS_LABELS = {
  GRADED: 'مصحّحة',
  SUBMITTED: 'مسلّمة ولم تُصحّح',
  GRADING: 'قيد التصحيح',
  IN_PROGRESS: 'جارية',
  EXPIRED: 'منتهية',
  PENDING: 'معلّقة',
  DONE: 'منتهية',
  FAILED: 'فاشلة',
  COMPLETED: 'مكتملة',
  REFUNDED: 'مستردّة',
  PENDING_PAYMENT: 'بانتظار الدفع',
  READY: 'جاهزة',
  UPLOADING: 'قيد الرفع',
  PROCESSING: 'قيد المعالجة',
  ADMIN_BROADCAST: 'بث إداري',
  QUIZ_GRADED: 'تصحيح اختبار',
  VIDEO_READY: 'فيديو جاهز',
};

function label(map, key) {
  return map[key] || key || '—';
}

function gradeLabel(grade) {
  return grade ? label(GRADE_LABELS, grade) : 'كل الصفوف';
}

/** 1234.5 → "1,234.5"; null/undefined → "—". */
function num(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** Percent values arrive on a 0..100 scale; ones already rounded by the tool. */
function pct(value) {
  if (value === null || value === undefined) return '—';
  return `${num(value)}%`;
}

/** AI confidence arrives on a 0..1 scale — shown as a percent, never as "0.9". */
function confidence(value) {
  if (value === null || value === undefined) return '—';
  return `${num(Math.round(Number(value) * 1000) / 10)}%`;
}

function egp(value) {
  if (value === null || value === undefined) return '—';
  return `${num(value)} جنيه`;
}

/** "2026-09-24T11:02:33.568Z" → "2026-09-24 14:02" (Africa/Cairo). */
function dt(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Markdown table with a header row; empty input renders as a short notice. */
function table(headers, rows) {
  if (!rows || !rows.length) return '_لا توجد صفوف لعرضها._';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

/**
 * The window line every answer carries. Either the tool reported a real window
 * ("آخر 7 أيام منذ ..."), or the answer is an instantaneous snapshot — saying so
 * is the difference between a fact and a guess.
 */
function windowLine(data, meta) {
  if (data && data.windowDays) {
    return `🕒 النافذة الزمنية: آخر ${num(data.windowDays)} يوم${data.sinceIso ? ` (منذ ${dt(data.sinceIso)})` : ''}.`;
  }
  return `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)}.`;
}

/** Truncation/sampling disclosure, appended to every row-returning answer. */
function notes(data, meta) {
  const out = [];
  if (data && data.truncated) {
    out.push(`ℹ️ النتائج مقصوصة عند ${num(data.returned)} صف (الحد الأقصى ${num(meta && meta.cappedAt)}).`);
  }
  if (data && data.sampled) {
    out.push(`ℹ️ بعض الأرقام محسوبة على عيّنة من ${num(data.sampledRows)} صف لتفادي الاستعلامات الثقيلة.`);
  }
  return out;
}

function join(parts) {
  return parts.filter(Boolean).join('\n\n');
}

// ── Renderers ─────────────────────────────────────────────────────────────────
// Each takes (data, meta) — the tool payload and the tool's metadata — and
// returns Arabic Markdown. No renderer may invent a number, and every one of them
// states its window through windowLine().
const RENDERERS = {
  platform_overview: (d, meta) => {
    const attempts = Object.entries(d.quizzes.attemptsByStatus || {})
      .map(([status, count]) => `${label(STATUS_LABELS, status)} ${num(count)}`)
      .join(' · ');
    const videos = Object.entries(d.videos.byStatus || {})
      .map(([status, count]) => `${label(STATUS_LABELS, status)} ${num(count)}`)
      .join(' · ');
    return join([
      '### نظرة عامة على المنصة',
      windowLine(d, meta),
      table(
        ['المؤشر', 'القيمة'],
        [
          ['الطلاب', num(d.users.students)],
          ['المشرفون', num(d.users.admins)],
          ['طلاب جدد خلال النافذة', num(d.users.newStudents7d)],
          ['الدورات', num(d.courses)],
          ['الشهادات الصادرة', num(d.certificates)],
        ]
      ),
      `**الاشتراكات:** الإجمالي ${num(d.enrollments.total)} · مدفوعة ${num(d.enrollments.paid)} · غير مدفوعة ${num(d.enrollments.unpaid)} · مكتملة ${num(d.enrollments.completed)} · جديدة خلال النافذة ${num(d.enrollments.newLast7Days)}`,
      `**الاختبارات:** ${num(d.quizzes.total)} اختبار · ${num(d.quizzes.attemptsTotal)} محاولة${attempts ? ` (${attempts})` : ''}`,
      `**الفيديوهات:** ${num(d.videos.total)}${videos ? ` (${videos})` : ''}`,
      `**يحتاج متابعة:** محاولات تنتظر التصحيح ${num(d.pendingWork.attemptsAwaitingGrading)} · مهام تصحيح آلي معلّقة ${num(d.pendingWork.aiGradingJobsPending)} · تسليمات مهام معلّقة ${num(d.pendingWork.assignmentSubmissionsPending)}`,
      notes(d, meta),
    ]);
  },

  platform_recent_activity: (d, meta) =>
    join([
      '### أحدث النشاط على المنصة',
      windowLine(d, meta),
      `_أحدث ${num(d.perSectionLimit)} عنصر في كل قسم._`,
      '**طلاب جدد**',
      table(
        ['الاسم', 'البريد', 'الصف', 'تاريخ الإنشاء'],
        (d.newUsers || []).map((u) => [u.name, u.email, gradeLabel(u.grade), dt(u.createdAt)])
      ),
      '**اشتراكات جديدة**',
      table(
        ['الطالب', 'الدورة', 'مدفوع؟', 'التاريخ'],
        (d.newEnrollments || []).map((e) => [e.student.name, e.course.title, e.isPaid ? 'نعم' : 'لا', dt(e.createdAt)])
      ),
      '**محاولات اختبارات**',
      table(
        ['الطالب', 'الاختبار', 'الحالة', 'الدرجة', 'التسليم'],
        (d.recentAttempts || []).map((a) => [
          a.student.name,
          a.quizTitle,
          label(STATUS_LABELS, a.status),
          pct(a.scorePercent),
          dt(a.submittedAt || a.startedAt),
        ])
      ),
      '**مدفوعات**',
      table(
        ['#', 'المبلغ', 'الحالة', 'التاريخ'],
        (d.recentPayments || []).map((p) => [p.id, egp(p.amount), label(STATUS_LABELS, p.status), dt(p.createdAt)])
      ),
      notes(d, meta),
    ]),

  students_by_grade: (d, meta) =>
    join([
      `### ${d.role === 'ADMIN' ? 'المشرفون' : 'الطلاب'} حسب الصف الدراسي`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الحساب على كل الحسابات المسجّلة حتى الآن.`,
      table(
        ['الصف', 'عدد الحسابات'],
        (d.byGrade || []).map((g) => [gradeLabel(g.grade), num(g.count)])
      ),
      `**الإجمالي:** ${num(d.total)} حساب.`,
      notes(d, meta),
    ]),

  students_new_trend: (d, meta) => {
    const isMonth = d.granularity === 'month';
    return join([
      '### اتجاه تسجيل الطلاب الجدد',
      `🕒 آخر ${num(d.periods)} ${isMonth ? 'شهر' : 'أسبوع'} (كل ${isMonth ? 'شهر' : 'أسبوع'} نافذة ثابتة مدتها ${isMonth ? '30' : '7'} يوم).`,
      table(
        ['الفترة', 'عدد الطلاب الجدد'],
        (d.buckets || []).map((b) => [`من ${dt(b.startIso)} إلى ${dt(b.endIso)}`, num(b.count)])
      ),
      notes(d, meta),
    ]);
  },

  student_profile: (d, meta) => {
    if (!d.found) {
      return join([
        '### ملف الطالب',
        `❌ لا يوجد طالب بالمعرّف \`${d.userSlug}\`. تأكد من نسخ المعرّف (slug) من رابط الملف.`,
      ]);
    }
    const s = d.student;
    return join([
      `### ملف الطالب: ${s.name}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الأرقام تراكمية من التسجيل حتى اللحظة.`,
      table(
        ['البند', 'القيمة'],
        [
          ['المعرّف (slug)', `\`${s.slug}\``],
          ['البريد', s.email || '—'],
          ['الهاتف', s.phoneNumber || '—'],
          ['الصف', gradeLabel(s.grade)],
          ['الدور', s.role === 'ADMIN' ? 'مشرف' : 'طالب'],
          ['تاريخ التسجيل', dt(s.createdAt)],
          ['آخر دخول', s.lastLoginAt ? dt(s.lastLoginAt) : 'لم يسجّل دخولًا'],
        ]
      ),
      `**الاشتراكات:** الإجمالي ${num(d.enrollments.total)} · مكتملة ${num(d.enrollments.completed)} · مدفوعة ${num(d.enrollments.paid)} · متوسط التقدّم ${pct(d.enrollments.avgProgress)}`,
      `**الاختبارات:** ${num(d.quizzes.attempts)} محاولة · متوسط الدرجات ${pct(d.quizzes.avgScore)}${d.quizzes.lastAttemptAtIso ? ` · آخر محاولة ${dt(d.quizzes.lastAttemptAtIso)}` : ''}`,
      `**إعفاءات بوابات الاختبارات:** ${num(d.gateExemptions)}`,
      notes(d, meta),
    ]);
  },

  student_ranking: (d, meta) => {
    const weakest = d.direction === 'bottom';
    return join([
      `### ${weakest ? 'أقل الطلاب في الدرجات' : 'أعلى الطلاب في الدرجات'}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — تراكمي على كل المحاولات المصحّحة (الحد الأدنى ${num(d.minAttempts)} محاولة).`,
      table(
        ['#', 'الطالب', 'الصف', 'متوسط الدرجات', 'عدد المحاولات'],
        (d.rows || []).map((r, i) => [num(i + 1), r.name, gradeLabel(r.grade), pct(r.avgScore), num(r.attempts)])
      ),
      (d.rows || []).length ? '' : 'لا توجد محاولات مصحّحة كافية لبناء ترتيب.',
      notes(d, meta),
    ]);
  },

  inactive_students: (d, meta) =>
    join([
      '### اشتراكات لم يتفاعل معها أصحابها',
      `🕒 آخر تفاعل أقدم من ${num(d.inactiveDays)} يوم (قبل ${dt(d.cutoffIso)}).`,
      table(
        ['الطالب', 'التواصل', 'الصف', 'الدورة', 'التقدّم', 'آخر تفاعل'],
        (d.rows || []).map((r) => [
          r.student.name,
          r.student.phoneNumber || r.student.email || '—',
          gradeLabel(r.student.grade),
          r.course.title,
          pct(r.progress),
          dt(r.lastAccessIso),
        ])
      ),
      notes(d, meta),
    ]),

  courses_list: (d, meta) =>
    join([
      `### الدورات${d.grade ? ` — ${gradeLabel(d.grade)}` : ''}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الترتيب: ${d.orderBy === 'enrollments' ? 'الأكثر اشتراكًا' : 'الأحدث إنشاءً'}.`,
      table(
        ['الدورة', 'الصف', 'التصنيف', 'السعر', 'المشتركون', 'الفيديوهات', 'تاريخ الإنشاء'],
        (d.rows || []).map((r) => [
          r.title,
          gradeLabel(r.grade),
          r.category || '—',
          egp(r.priceEgp),
          num(r.enrollments),
          `${num(r.readyVideos)}/${num(r.videos)} جاهزة`,
          dt(r.createdAtIso),
        ])
      ),
      notes(d, meta),
    ]),

  course_detail: (d, meta) => {
    if (!d.found) {
      return join([
        '### تفاصيل الدورة',
        `❌ لا توجد دورة بالمعرّف \`${d.courseSlug}\`.`,
      ]);
    }
    return join([
      `### تفاصيل الدورة: ${d.title}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الأرقام تراكمية.`,
      table(
        ['البند', 'القيمة'],
        [
          ['المعرّف (slug)', `\`${d.courseSlug}\``],
          ['الصف', gradeLabel(d.grade)],
          ['التصنيف', d.category || '—'],
          ['السعر', egp(d.priceEgp)],
          ['تاريخ الإنشاء', dt(d.createdAtIso)],
          ['المشتركون', num(d.enrollments.total)],
          ['المدفوعون', num(d.enrollments.paid)],
          ['أكملوا الدورة', num(d.enrollments.completed)],
          ['متوسط التقدّم', pct(d.enrollments.avgProgress)],
          ['الفيديوهات', `${num(d.videos.ready)}/${num(d.videos.total)} جاهزة`],
          ['الاختبارات', num(d.quizzes)],
          ['الشهادات', num(d.certificates)],
          ['مدفوعات مكتملة', `${num(d.payments.completed)} بقيمة ${egp(d.payments.amountEgp)}`],
        ]
      ),
      notes(d, meta),
    ]);
  },

  course_completion_rates: (d, meta) =>
    join([
      `### نسب إكمال الدورات${d.grade ? ` — ${gradeLabel(d.grade)}` : ''}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الدورات بلا مشتركين لا تظهر لأن النسبة بلا معنى فيها.`,
      table(
        ['الدورة', 'الصف', 'المشتركون', 'أكملوا', 'نسبة الإكمال', 'متوسط التقدّم'],
        (d.rows || []).map((r) => [
          r.title,
          gradeLabel(r.grade),
          num(r.enrollments),
          num(r.completed),
          pct(r.completionRate),
          pct(r.avgProgress),
        ])
      ),
      notes(d, meta),
    ]),

  courses_by_grade: (d, meta) =>
    join([
      '### توزيع الدورات على الصفوف',
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)}.`,
      table(
        ['الصف', 'عدد الدورات', 'عدد الاشتراكات', 'متوسط سعر الدورة'],
        (d.byGrade || []).map((g) => [gradeLabel(g.grade), num(g.courses), num(g.enrollments), egp(g.avgPriceEgp)])
      ),
      notes(d, meta),
    ]),

  video_pipeline_status: (d, meta) => {
    const statuses = Object.entries(d.byStatus || {})
      .map(([status, count]) => `${label(STATUS_LABELS, status)}: ${num(count)}`)
      .join(' · ');
    const stuck = d.stuck || { rows: [] };
    const failed = d.failed || { rows: [] };
    return join([
      '### حالة معالجة فيديوهات باني',
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)}.`,
      `**حسب الحالة:** ${statuses}`,
      `**عالقة في المعالجة أكثر من ${num(d.staleMinutes)} دقيقة:** ${num(d.stuckCount)} فيديو${stuck.truncated ? ' (تُعرض أقدمها)' : ''}`,
      table(
        ['الفيديو', 'الدورة', 'تقدّم المعالجة', 'عالق منذ (دقيقة)', 'آخر تحديث'],
        (stuck.rows || []).map((v) => [
          v.title,
          v.courseTitle || '—',
          pct(v.processingProgress),
          num(v.stuckMinutes),
          dt(v.updatedAtIso),
        ])
      ),
      `**فيديوهات فاشلة:** ${num((failed.rows || []).length)}${failed.truncated ? ' (تُعرض أحدثها)' : ''}`,
      table(
        ['الفيديو', 'الدورة', 'سبب الفشل'],
        (failed.rows || []).map((v) => [v.title, v.courseTitle || '—', v.failureReason || 'غير مسجّل'])
      ),
      notes(d, meta),
    ]);
  },

  video_engagement: (d, meta) =>
    join([
      `### تفاعل الطلاب مع الفيديوهات${d.courseSlug ? ` — الدورة \`${d.courseSlug}\`` : ''}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — تراكمي على كل المشاهدات.`,
      `**الإجمالي:** ${num(d.overall.viewers)} مشاهد · ${num(d.overall.completed)} أكملوا المشاهدة · نسبة الإكمال ${pct(d.overall.completionRate)}`,
      table(
        ['الفيديو', 'الدورة', 'المشاهدون', 'أكملوا', 'نسبة الإكمال'],
        (d.rows || []).map((r) => [
          r.videoTitle,
          r.courseTitle || '—',
          num(r.viewers),
          num(r.completed),
          pct(r.completionRate),
        ])
      ),
      notes(d, meta),
    ]),

  quiz_list: (d, meta) =>
    join([
      '### الاختبارات ومؤشرات أدائها',
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — مؤشرات الأداء على أحدث ${num(d.sampledRows)} محاولة مصحّحة فقط، وليست محصورة في نافذة زمنية.`,
      table(
        ['الاختبار', 'الفيديو', 'درجة النجاح', 'المحاولات المسموحة', 'المدة', 'محاولات', 'مصحّحة', 'متوسط الدرجات', 'نسبة النجاح'],
        (d.rows || []).map((r) => [
          r.title,
          r.videoTitle || '—',
          pct(r.passingScore),
          num(r.maxAttempts),
          r.timeLimitSec ? `${num(Math.round(r.timeLimitSec / 60))} دقيقة` : 'غير محددة',
          num(r.attempts),
          num(r.graded),
          pct(r.avgScore),
          pct(r.passRate),
        ])
      ),
      notes(d, meta),
    ]),

  quiz_pass_rates: (d, meta) =>
    join([
      `### نسب النجاح في الاختبارات${d.courseSlug ? ` — الدورة \`${d.courseSlug}\`` : ''}`,
      windowLine(d, meta),
      table(
        ['الاختبار', 'محاولات مصحّحة', 'ناجح', 'راسب', 'نسبة النجاح', 'متوسط الدرجات'],
        (d.rows || []).map((r) => [
          r.title,
          num(r.gradedAttempts),
          num(r.passed),
          num(r.failed),
          pct(r.passRate),
          pct(r.avgScore),
        ])
      ),
      notes(d, meta),
    ]),

  quiz_attempts: (d, meta) =>
    join([
      '### محاولات الاختبارات',
      windowLine(d, meta),
      table(
        ['الطالب', 'الصف', 'الاختبار', 'الحالة', 'الدرجة', 'المحاولة #', 'التسليم'],
        (d.rows || []).map((r) => [
          r.student.name,
          gradeLabel(r.student.grade),
          r.quiz.title,
          label(STATUS_LABELS, r.status),
          pct(r.scorePercent),
          num(r.attemptNumber),
          dt(r.submittedAtIso || r.startedAtIso),
        ])
      ),
      notes(d, meta),
    ]),

  quiz_difficulty: (d, meta) =>
    join([
      '### أصعب الاختبارات (حسب نسبة الرسوب)',
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — من الأصعب إلى الأسهل، والحد الأدنى ${num(d.minAttempts)} محاولة مصحّحة.`,
      table(
        ['#', 'الاختبار', 'محاولات مصحّحة', 'راسبون', 'نسبة الرسوب', 'متوسط الدرجات'],
        (d.rows || []).map((r, i) => [
          num(i + 1),
          r.title,
          num(r.attempts),
          num(r.failed),
          pct(r.failRate),
          pct(r.avgScore),
        ])
      ),
      (d.rows || []).length ? '' : 'لا توجد اختبارات بمحاولات مصحّحة كافية للترتيب.',
      notes(d, meta),
    ]),

  grading_backlog: (d, meta) =>
    join([
      '### ما ينتظر التصحيح الآن',
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)}.`,
      table(
        ['الحالة', 'العدد'],
        [
          ['محاولات قيد التصحيح (GRADING)', num(d.counts.attemptsGrading)],
          ['محاولات مسلّمة ولم تُصحّح (SUBMITTED)', num(d.counts.attemptsSubmitted)],
          ['تسليمات مهام معلّقة', num(d.counts.submissionsPending)],
          ['مهام تصحيح آلي معلّقة', num(d.aiJobsByStatus.PENDING)],
          ['مهام تصحيح آلي منتهية', num(d.aiJobsByStatus.DONE)],
          ['مهام تصحيح آلي فاشلة', num(d.aiJobsByStatus.FAILED)],
        ]
      ),
      d.oldestPendingAgeHours === null
        ? 'لا توجد مهام تصحيح آلي معلّقة.'
        : `⏳ عمر أقدم مهمة تصحيح آلي معلّقة: ${num(d.oldestPendingAgeHours)} ساعة.`,
      '**أقدم المحاولات المنتظرة**',
      table(
        ['الطالب', 'الاختبار', 'الفيديو', 'المحاولة #', 'وقت التسليم'],
        (d.rows || []).map((r) => [
          r.student.name,
          r.quizTitle || '—',
          r.videoTitle || '—',
          num(r.attemptNumber),
          dt(r.submittedAtIso),
        ])
      ),
      notes(d, meta),
    ]),

  ai_grading_stats: (d, meta) =>
    join([
      '### إحصاءات التصحيح الآلي',
      windowLine(d, meta),
      table(
        ['الحالة', 'عدد المهام', 'متوسط الثقة'],
        [
          ['معلّقة (PENDING)', num(d.byStatus.PENDING.count), confidence(d.byStatus.PENDING.avgConfidence)],
          ['منتهية (DONE)', num(d.byStatus.DONE.count), confidence(d.byStatus.DONE.avgConfidence)],
          ['فاشلة (FAILED)', num(d.byStatus.FAILED.count), confidence(d.byStatus.FAILED.avgConfidence)],
        ]
      ),
      `**طُبّق حكمها:** ${num(d.applied)} · **لم يُطبّق:** ${num(d.notApplied)} · **فشلت بعد استنفاد المحاولات:** ${num(d.failedExhaustedRetries)}`,
      '_الثقة معروضة كنسبة مئوية من مقياس 0 إلى 1._',
      notes(d, meta),
    ]),

  essay_turnaround: (d, meta) =>
    join([
      '### زمن تصحيح الأسئلة المقالية',
      windowLine(d, meta),
      table(
        ['المؤشر', 'بالساعات'],
        [
          ['حجم العيّنة', num(d.sampleSize)],
          ['المتوسط', num(d.avgHours)],
          ['الوسيط', num(d.medianHours)],
          ['الأسرع', num(d.fastestHours)],
          ['الأبطأ', num(d.slowestHours)],
        ]
      ),
      '_الزمن محسوب من لحظة التسليم حتى تصحيح المقالي._',
      notes(d, meta),
    ]),

  enrollment_stats: (d, meta) =>
    join([
      '### إحصاءات الاشتراكات',
      windowLine(d, meta),
      table(
        ['البند', 'القيمة'],
        [
          ['الإجمالي', num(d.total)],
          ['مدفوعة', num(d.paid)],
          ['غير مدفوعة', num(d.unpaid)],
          ['مكتملة', num(d.completed)],
          ['جديدة خلال النافذة', num(d.newInWindow)],
          ['اكتملت خلال النافذة', num(d.completedInWindow)],
          ['متوسط التقدّم', pct(d.avgProgress)],
        ]
      ),
      '_الإجماليات تراكمية، والأرقام «خلال النافذة» محسوبة على تاريخ الإنشاء/الإكمال._',
      notes(d, meta),
    ]),

  enrollment_trend: (d, meta) => {
    const isMonth = d.granularity === 'month';
    return join([
      '### اتجاه الاشتراكات الجديدة',
      `🕒 آخر ${num(d.periods)} ${isMonth ? 'شهر' : 'أسبوع'} (كل ${isMonth ? 'شهر' : 'أسبوع'} نافذة ثابتة مدتها ${isMonth ? '30' : '7'} يوم) — الفترة محسوبة من تاريخ إنشاء الاشتراك.`,
      table(
        ['الفترة', 'الإجمالي', 'مدفوعة', 'غير مدفوعة'],
        (d.buckets || []).map((b) => [
          `من ${dt(b.startIso)} إلى ${dt(b.endIso)}`,
          num(b.total),
          num(b.paid),
          num(b.unpaid),
        ])
      ),
      notes(d, meta),
    ]);
  },

  enrollment_by_course: (d, meta) =>
    join([
      `### اشتراكات الدورات${d.grade ? ` — ${gradeLabel(d.grade)}` : ''}`,
      `🕒 لقطة لحظية بتاريخ ${dt(meta && meta.asOf)} — الإيرادات تراكمية (المدفوعات المكتملة فقط).`,
      table(
        ['الدورة', 'الصف', 'الاشتراكات', 'أكملوا', 'نسبة الإكمال', 'متوسط التقدّم', 'الإيرادات', 'عدد المدفوعات'],
        (d.rows || []).map((r) => [
          r.title,
          gradeLabel(r.grade),
          num(r.enrollments),
          num(r.completed),
          pct(r.completionRate),
          pct(r.avgProgress),
          egp(r.revenueEgp),
          num(r.paymentsCount),
        ])
      ),
      notes(d, meta),
    ]),

  revenue_summary: (d, meta) =>
    join([
      '### ملخّص الإيرادات',
      windowLine(d, meta),
      table(
        ['الحالة', 'عدد العمليات', 'المبلغ'],
        [
          ['مكتملة', num(d.byStatus.COMPLETED.count), egp(d.byStatus.COMPLETED.amount)],
          ['مستردّة', num(d.byStatus.REFUNDED.count), egp(d.byStatus.REFUNDED.amount)],
          ['فاشلة', num(d.byStatus.FAILED.count), egp(d.byStatus.FAILED.amount)],
          ['معلّقة', num(d.byStatus.PENDING.count), egp(d.byStatus.PENDING.amount)],
          ['منتهية', num(d.byStatus.EXPIRED.count), egp(d.byStatus.EXPIRED.amount)],
        ]
      ),
      `**الإيرادات المحصّلة:** ${egp(d.revenueEgp)} من ${num(d.completedCount)} عملية · **المبالغ المستردّة:** ${egp(d.refundedEgp)} · **متوسط قيمة العملية:** ${egp(d.avgOrderValueEgp)}`,
      `**عمليات لم تكتمل:** فاشلة ${num(d.failedCount)} · معلّقة ${num(d.pendingCount)}`,
      notes(d, meta),
    ]),

  payment_issues: (d, meta) => {
    const failed = d.failedOrExpired || { rows: [] };
    const flags = d.auditFlags || { rows: [] };
    return join([
      '### مشاكل الدفع',
      windowLine(d, meta),
      '**عمليات الدفع غير المكتملة (فاشلة/منتهية)**',
      table(
        ['#', 'المبلغ', 'الحالة', 'سبب الفشل', 'التاريخ'],
        (failed.rows || []).map((p) => [
          p.id,
          egp(p.amount),
          label(STATUS_LABELS, p.status),
          p.failureReason || 'غير مسجّل',
          dt(p.createdAtIso),
        ])
      ),
      '**إشارات من سجل التدقيق (تحتاج مراجعة يدوية)**',
      table(
        ['#', 'العملية', 'الهدف', 'التاريخ'],
        (flags.rows || []).map((row) => [
          row.id,
          row.action,
          `${row.targetType || '—'} #${row.targetId === null || row.targetId === undefined ? '—' : row.targetId}`,
          dt(row.createdAtIso),
        ])
      ),
      '_إشارات التدقيق تشمل: عدم تطابق المبلغ، وتحصيلًا مكررًا، ومدفوعات مكتملة لمراجعة المطابقة._',
      notes(d, meta),
    ]);
  },

  notification_stats: (d, meta) => {
    const batches = d.topBatches || { rows: [] };
    return join([
      '### إحصاءات الإشعارات',
      windowLine(d, meta),
      table(
        ['النوع', 'العدد'],
        [
          ['تصحيح اختبار', num(d.byType.QUIZ_GRADED)],
          ['فيديو جاهز', num(d.byType.VIDEO_READY)],
          ['بث إداري', num(d.byType.ADMIN_BROADCAST)],
        ]
      ),
      `**الإجمالي خلال النافذة:** ${num(d.totalInWindow)} إشعار · **مقروء:** ${num(d.read)} · **غير مقروء:** ${num(d.unread)} · **عدد دفعات البث:** ${num(d.batchCount)}`,
      '**أكثر دفعات البث استقبالًا**',
      table(
        ['معرّف الدفعة', 'عدد المستلمين'],
        (batches.rows || []).map((b) => [`\`${b.batchId}\``, num(b.recipients)])
      ),
      notes(d, meta),
    ]);
  },

  admin_audit_recent: (d, meta) => {
    const filters = d.filters || {};
    const filterText = [filters.action ? `العملية: ${filters.action}` : null, filters.targetType ? `نوع الهدف: ${filters.targetType}` : null]
      .filter(Boolean)
      .join(' · ');
    return join([
      '### أحدث العمليات الإدارية (سجل التدقيق)',
      windowLine(d, meta),
      filterText ? `🔎 التصفية المطبّقة — ${filterText}.` : '',
      table(
        ['#', 'العملية', 'المنفّذ', 'الهدف', 'تفاصيل مختصرة', 'التاريخ'],
        (d.rows || []).map((row) => [
          row.id,
          row.action,
          row.actorId === null || row.actorId === undefined ? 'النظام' : `#${row.actorId}`,
          `${row.targetType || '—'} #${row.targetId === null || row.targetId === undefined ? '—' : row.targetId}`,
          row.metadataSummary || '—',
          dt(row.createdAtIso),
        ])
      ),
      notes(d, meta),
    ]);
  },
};

// Two intents share one renderer: a ranking is a ranking. The payload's
// `direction` decides the title, so the fast path can never answer "weakest
// students" under a "best students" heading.
RENDERERS.top_students = RENDERERS.student_ranking;
RENDERERS.weak_students = RENDERERS.student_ranking;

const TEMPLATE_IDS = Object.keys(RENDERERS);

/**
 * Render an answer. Throws on an unknown template: a missing renderer is a
 * wiring bug that must surface at boot (engine.js checks every intent), never as
 * an empty answer in front of an admin.
 */
function renderAnswer(templateId, data, meta = {}) {
  const render = RENDERERS[templateId];
  if (typeof render !== 'function') {
    throw new Error(`[agent/templates] unknown template "${templateId}"`);
  }
  return render(data || {}, meta || {});
}

module.exports = {
  renderAnswer,
  TEMPLATE_IDS,
  RENDERERS,
  // Formatting primitives exported for tests (and for the Phase 3 agentic tier,
  // which must format numbers exactly like the fast path does).
  num,
  pct,
  egp,
  dt,
  confidence,
  gradeLabel,
};

