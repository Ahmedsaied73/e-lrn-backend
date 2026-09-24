'use strict';

/**
 * router.js — the DETERMINISTIC fast path (Phase 2).
 *
 * WHY THIS EXISTS: admins ask the same twenty questions over and over. Those
 * deserve an answer that is instant, free, reproducible and incapable of
 * hallucination — i.e. no LLM at all. Whatever the catalogue cannot match
 * (free-form wording, multi-step questions, lookups by a person's NAME) falls
 * through to the agentic tier in Phase 3, which is where an LLM earns its cost.
 *
 * CONTRACT: this module is PURE. No Prisma, no Redis, no clock, no I/O. It maps
 * a normalized Arabic question to { id, tool, template, args, score } only.
 * engine.js then validates those args against the tool's STRICT Zod schema and
 * executes it. That split is what makes the fast path unit-testable with no DB.
 *
 * MATCHING IS DELIBERATELY CONSERVATIVE. An unclear question — or one that two
 * intents match equally well — returns matched:false so the LLM answers it: a
 * confident wrong answer is worse than "let me think about that". Ties are
 * ambiguity, never a coin flip.
 */

// Diacritics + tatweel.
const DIACRITICS_RE = /[\u0617-\u061A\u064B-\u0655\u0670\u0640]/g;
const INDIC_DIGITS_RE = /[\u0660-\u0669\u06F0-\u06F9]/g;
// Punctuation that carries no meaning for matching. '.' is KEPT (slugs, numbers)
// and '%' is kept so "نسبة 50%" survives intact.
const PUNCT_RE = /[\u060C\u061B\u061F\u066A-\u066E!?;:"'`()[\]{}«»<>_/\\|*+=~^$#@&,\u2013\u2014\u2022\u200E\u200F]/g;

/**
 * Normalize Arabic for matching: unify letter variants, drop diacritics,
 * convert Arabic-Indic digits to ASCII, lowercase, collapse whitespace.
 * Idempotent on purpose — tests normalize their expected strings too.
 */
function normalize(text) {
  if (typeof text !== 'string') return '';
  let out = text
    .replace(DIACRITICS_RE, '')
    .replace(/[\u0622\u0623\u0625\u0671-\u0673]/g, '\u0627') // آ أ إ ٱ → ا
    .replace(/\u0649/g, '\u064A') // ى → ي
    .replace(/\u0626/g, '\u064A') // ئ → ي
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/\u0624/g, '\u0648'); // ؤ → و
  out = out.replace(INDIC_DIGITS_RE, (ch) => {
    const code = ch.codePointAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  return out.replace(PUNCT_RE, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalized tokens (used for sequence matching and slot extraction). */
function tokenize(normalized) {
  return normalized ? normalized.split(' ') : [];
}

/**
 * Token equality with Arabic PREFIX tolerance. Admins write "للإيرادات",
 * "بالكورسات", "والطلاب" — the same word with a clitic و/ف/ل/ب/ك attached. Only
 * those prefixes are tolerated (never arbitrary characters), so "كورس" can never
 * be confused with "ورس".
 */
const CLITICS = ['ال', 'و', 'ف', 'ل', 'ب', 'ك', 'وال', 'فال', 'بال', 'كال', 'لل', 'ولل'];

/**
 * Equality, or equality after removing exactly one known clitic. The remainder
 * MUST equal the expected token: an earlier "prefix-only" check made "باني"
 * match "دخل" (both start with ب), which silently answered the wrong question.
 */
function tokenMatches(candidate, expected) {
  if (candidate === expected) return true;
  return CLITICS.some((clitic) => candidate === clitic + expected);
}

/** Does `tokens` contain `phrase` as a contiguous run? */
function containsSequence(tokens, phrase) {
  if (!phrase.length || phrase.length > tokens.length) return false;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let all = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (!tokenMatches(tokens[i + j], phrase[j])) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** A phrase written as text ("عدد الطلاب") becomes normalized tokens. */
function phraseTokens(phrase) {
  return Array.isArray(phrase) ? phrase.map((t) => normalize(t)) : tokenize(normalize(phrase));
}

// ── Counts ────────────────────────────────────────────────────────────────────
// Colloquial + MSA, because admins type both. Ordinals are intentionally absent:
// "تاني"/"تالت" mean a GRADE here ("تانية ثانوي"), never a count.
const NUMBER_WORDS = {
  'واحد': 1, 'واحده': 1, 'اتنين': 2, 'اثنين': 2, 'تلاته': 3, 'ثلاثه': 3,
  'اربعه': 4, 'خمسه': 5, 'سته': 6, 'سبعه': 7, 'تمانيه': 8, 'ثمانيه': 8,
  'تسعه': 9, 'عشره': 10,
};

/** First explicit count in the question: "5" or "خمسة" → 5. Else null. */
function extractCount(norm) {
  const digit = /\d+/.exec(norm);
  if (digit) {
    const n = Number(digit[0]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  for (const token of tokenize(norm)) {
    if (NUMBER_WORDS[token] !== undefined) return NUMBER_WORDS[token];
  }
  return null;
}

const UNIT_DAYS = {
  'ساعه': 1 / 24, 'ساعات': 1 / 24,
  'يوم': 1, 'ايام': 1, 'اسبوع': 7, 'اسابيع': 7,
  'شهر': 30, 'شهور': 30, 'سنه': 365, 'سنين': 365, 'سنوات': 365, 'عام': 365, 'اعوام': 365,
};

// ── Time windows ──────────────────────────────────────────────────────────────
const WINDOW_PHRASES = [
  { days: 1, phrases: ['اليوم', 'النهارده', 'امبارح', 'امس', 'اخر 24 ساعه', 'اخر يوم'] },
  { days: 7, phrases: ['اخر اسبوع', 'الاسبوع الماضي', 'هذا الاسبوع', 'الاسبوع ده', 'اخر 7 ايام'] },
  { days: 14, phrases: ['اخر اسبوعين', 'اخر 14 يوم'] },
  { days: 30, phrases: ['اخر شهر', 'الشهر الماضي', 'هذا الشهر', 'الشهر ده', 'اخر 30 يوم', 'اخر شهرين'] },
  { days: 90, phrases: ['اخر 3 شهور', 'اخر تلاته شهور', 'اخر 90 يوم', 'اخر ربع سنه'] },
  { days: 365, phrases: ['اخر سنه', 'السنه الماضيه', 'اخر 12 شهر', 'اخر 365 يوم'] },
];

/**
 * Window size in days, or null when the question carries no explicit window —
 * the tool's own default then applies. The router must never invent a time
 * range: "عدد الطلاب" is not "عدد الطلاب في آخر 30 يوم".
 * The generic form is tried first, so "اخر 45 يوم" works without being listed.
 */
function extractWindowDays(norm) {
  const tokens = tokenize(norm);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'اخر' && tokens[i] !== 'خلال') continue;
    for (let k = i + 1; k <= Math.min(i + 2, tokens.length - 1); k += 1) {
      const n = /^\d+$/.test(tokens[k]) ? Number(tokens[k]) : NUMBER_WORDS[tokens[k]];
      if (!n) continue;
      for (let u = k + 1; u <= Math.min(k + 2, tokens.length - 1); u += 1) {
        const unit = UNIT_DAYS[tokens[u]];
        if (unit) {
          const days = Math.round(n * unit);
          if (days > 0 && days <= 3650) return days;
        }
      }
    }
  }
  for (const entry of WINDOW_PHRASES) {
    if (entry.phrases.some((p) => containsSequence(tokens, phraseTokens(p)))) return entry.days;
  }
  return null;
}

const GRANULARITY_WORDS = {
  week: ['اسبوع', 'اسبوعين', 'اسابيع', 'اسبوعي', 'اسبوعيا', 'weekly'],
  month: ['شهر', 'شهرين', 'شهور', 'اشهر', 'شهري', 'شهريا', 'monthly'],
};

/** Bucket granularity + count for the two trend tools, or null. */
function extractTrend(norm) {
  const tokens = tokenize(norm);
  const granularity = Object.keys(GRANULARITY_WORDS).find((key) =>
    GRANULARITY_WORDS[key].some((w) => tokens.includes(w))
  );
  if (!granularity) return null;
  const count = extractCount(norm);
  // The number in "اخر 4 اسابيع" is what matters; a stray larger number is not a
  // bucket count, so it is dropped rather than passed through to the tool.
  return { granularity, periods: count && count <= 24 ? count : null };
}

// ── "How many rows do you want to see" ────────────────────────────────────────
const TAKE_MARKERS = ['اعلي', 'افضل', 'اكبر', 'اقوي', 'اصعب', 'اسهل', 'اخطر', 'اعلا', 'top'];

/** "أعلى 5 / أفضل 10 / أصعب 3" → 5 / 10 / 3. Else null (tool default applies). */
function extractTake(norm) {
  const tokens = tokenize(norm);
  if (!tokens.some((t) => TAKE_MARKERS.includes(t))) return null;
  const n = extractCount(norm);
  return n && n <= 50 ? n : null;
}

// ── Grades (the real Prisma enum: Grade.FIRST/SECOND/THIRD_SECONDARY) ─────────
const GRADE_PHRASES = [
  { grade: 'FIRST_SECONDARY', phrases: ['اولي ثانوي', 'الاولي ثانوي', 'صف اول', 'الصف الاول', 'اول ثانوي', '1 ثانوي'] },
  { grade: 'SECOND_SECONDARY', phrases: ['تانيه ثانوي', 'التانيه ثانوي', 'صف تاني', 'الصف الثاني', 'تاني ثانوي', '2 ثانوي'] },
  { grade: 'THIRD_SECONDARY', phrases: ['تالته ثانوي', 'التالته ثانوي', 'صف تالت', 'الصف الثالث', 'تالت ثانوي', '3 ثانوي'] },
];

function extractGrade(norm) {
  const tokens = tokenize(norm);
  for (const entry of GRADE_PHRASES) {
    if (entry.phrases.some((p) => containsSequence(tokens, phraseTokens(p)))) return entry.grade;
  }
  return null;
}

// ── Public slug (12 chars of [a-z0-9] — the app-wide shape) ───────────────────
const SLUG_RE = /\b[a-z0-9]{12}\b/;

function extractSlug(norm) {
  const match = SLUG_RE.exec(norm);
  return match ? match[0] : null;
}

// ── Quiz-attempt status (AttemptStatus enum) ──────────────────────────────────
const STATUS_PHRASES = [
  { status: 'SUBMITTED', phrases: ['مسلم', 'مسلمه', 'مستلم', 'مستلمه', 'لم تصحح', 'بانتظار التصحيح'] },
  { status: 'GRADED', phrases: ['مصحح', 'مصححه', 'تم تصحيحها', 'درجتها ظهرت'] },
  { status: 'GRADING', phrases: ['قيد التصحيح', 'جاري التصحيح', 'بيتصحح'] },
  { status: 'IN_PROGRESS', phrases: ['جاري الحل', 'قيد الحل', 'لم يسلم', 'مبدوء', 'مبدوءه'] },
  { status: 'EXPIRED', phrases: ['منتهي', 'منتهيه', 'انتهت المده', 'وقته خلص'] },
];

function extractAttemptStatus(norm) {
  const tokens = tokenize(norm);
  for (const entry of STATUS_PHRASES) {
    if (entry.phrases.some((p) => containsSequence(tokens, phraseTokens(p)))) return entry.status;
  }
  return null;
}

// ── Thresholds ────────────────────────────────────────────────────────────────
// A threshold is NOT a window: "خامل من 30 يوم" filters rows by their last
// activity, while "خلال آخر 30 يوم" counts rows created in a range. Different
// columns, so they are parsed by different functions on purpose.
function dayThresholdFrom(norm, { min, max }) {
  const tokens = tokenize(norm);
  for (let i = 0; i < tokens.length; i += 1) {
    const n = /^\d+$/.test(tokens[i]) ? Number(tokens[i]) : NUMBER_WORDS[tokens[i]];
    if (!n) continue;
    for (let u = i + 1; u <= Math.min(i + 2, tokens.length - 1); u += 1) {
      const unit = UNIT_DAYS[tokens[u]];
      if (!unit || unit < 1) continue;
      const days = Math.round(n * unit);
      if (days >= min && days <= max) return days;
    }
  }
  return null;
}

/** Inactivity threshold in days (1..365) — requires a marker so a plain window
 *  ("آخر 30 يوم") is never turned into a filter on last access. */
function extractInactiveDays(norm) {
  const tokens = tokenize(norm);
  if (!tokens.some((t) => ['من', 'لمده', 'اكتر', 'اكثر', 'خاملين', 'متوقفين'].includes(t))) return null;
  return dayThresholdFrom(norm, { min: 1, max: 365 });
}

/** Stale-video threshold in MINUTES (5..1440) — the one sub-day unit we accept. */
function extractStaleMinutes(norm) {
  const tokens = tokenize(norm);
  for (let i = 0; i < tokens.length; i += 1) {
    const n = /^\d+$/.test(tokens[i]) ? Number(tokens[i]) : NUMBER_WORDS[tokens[i]];
    if (!n) continue;
    const unit = tokens[i + 1];
    const minutes = unit === 'دقيقه' || unit === 'دقايق' ? n : ['ساعه', 'ساعات'].includes(unit) ? n * 60 : null;
    if (minutes !== null && minutes >= 5 && minutes <= 1440) return minutes;
  }
  return null;
}

// ── Slots and scoring ─────────────────────────────────────────────────────────
/** A phrase list is worth its token count, so "عدد الطلاب" (2) beats "الطلاب" (1). */
const MIN_SCORE = 2;

/** Every slot the catalogue can consume, extracted once per question. */
function extractSlots(norm) {
  return {
    windowDays: extractWindowDays(norm),
    trend: extractTrend(norm),
    take: extractTake(norm),
    grade: extractGrade(norm),
    slug: extractSlug(norm),
    status: extractAttemptStatus(norm),
    inactiveDays: extractInactiveDays(norm),
    staleMinutes: extractStaleMinutes(norm),
    hasCourseWord: /(كورس|دوره|دورات|كورسات)/.test(norm),
  };
}

/** Contiguous-phrase score: sum of matched phrase lengths. */
function scoreOf(tokens, phrases) {
  let score = 0;
  for (const phrase of phrases) {
    const pt = phraseTokens(phrase);
    if (containsSequence(tokens, pt)) score += pt.length;
  }
  return score;
}

/** Drop empty slots so a tool's own default applies instead of an explicit null. */
function compact(args) {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * Route a raw admin question.
 *
 * Returns { matched: true, id, tool, template, args, score, slots } on a
 * confident match, or { matched: false, reason, candidates } where reason is
 * EMPTY | NO_INTENT | AMBIGUOUS | MISSING_SLOT_SLUG. A false result is a routing
 * decision for the caller (Phase 3 answers it with the LLM), not an error.
 */
function route(question) {
  const norm = normalize(question);
  if (!norm) return { matched: false, reason: 'EMPTY', candidates: [] };

  // Numbers are DATA, not vocabulary: "أفضل 5 طلاب" must still match the phrase
  // "أفضل طلاب". Slots are extracted from `norm` (which keeps the digits), so
  // dropping them here cannot lose a window/count.
  const tokens = tokenize(norm).filter((t) => !/^\d+$/.test(t));
  const slots = extractSlots(norm);
  const scored = [];
  let needsSlug = null;

  for (const intent of INTENTS) {
    const score = scoreOf(tokens, intent.phrases);
    if (score === 0) continue;
    if (intent.exclude && intent.exclude.some((p) => containsSequence(tokens, phraseTokens(p)))) continue;
    if (score < (intent.minScore === undefined ? MIN_SCORE : intent.minScore)) continue;
    if (intent.requiresSlug && !slots.slug) {
      needsSlug = needsSlug || intent.id;
      continue;
    }
    scored.push({ id: intent.id, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return needsSlug
      ? { matched: false, reason: 'MISSING_SLOT_SLUG', candidates: [needsSlug], slots }
      : { matched: false, reason: 'NO_INTENT', candidates: [], slots };
  }
  // Equal top scores mean two intents explained the question equally well. The
  // honest move is to hand it to the LLM rather than pick by catalogue order.
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    const top = scored.filter((s) => s.score === scored[0].score).map((s) => s.id);
    return { matched: false, reason: 'AMBIGUOUS', candidates: top, slots };
  }

  const winner = INTENTS.find((i) => i.id === scored[0].id);
  return {
    matched: true,
    id: winner.id,
    tool: winner.tool,
    template: winner.template,
    args: compact(winner.args(slots)),
    score: scored[0].score,
    slots,
    candidates: scored.map((s) => ({ id: s.id, score: s.score })),
  };
}

// ═══ THE CATALOGUE ════════════════════════════════════════════════════════════
// One entry per recurring admin question. `samples` are the exact questions the
// entry must answer — tests/agent-router.test.js replays them, so the catalogue
// is executable documentation, and samples also prove the phrase sets are not
// just plausible but sufficient. `args(slots)` returns ONLY the arguments the
// question actually contained: an absent slot is omitted so the tool's own
// default applies instead of a silently wrong zero.
const INTENTS = [
  {
    id: 'platform_overview',
    tool: 'platform_overview',
    template: 'platform_overview',
    samples: ['نظرة عامة على المنصة', 'إحصائيات المنصة', 'ملخص المنصة'],
    phrases: ['نظره عامه', 'ملخص عام', 'احصائيات المنصه', 'ملخص المنصه', 'نظره شامله'],
    // A question that names money or subscriptions is never "the overview": it
    // belongs to the revenue/enrollment intents even when it also says "ملخص".
    exclude: ['الايرادات', 'ايرادات', 'الدخل', 'دخل', 'الارباح', 'ربح', 'المدفوعات', 'الاشتراكات', 'اشتراكات', 'الفيديوهات', 'الاختبارات'],
    args: () => ({}),
  },
  {
    id: 'platform_recent_activity',
    tool: 'platform_recent_activity',
    template: 'platform_recent_activity',
    samples: ['ما هو النشاط الأخير؟', 'أحدث النشاطات', 'ماذا حدث في المنصة اليوم؟', 'آخر الأحداث'],
    phrases: ['النشاط الاخير', 'احدث النشاط', 'احدث النشاطات', 'النشاطات الاخيره', 'اخر الاحداث', 'الاحداث الاخيره', 'ماذا حدث', 'ايه اللي حصل'],
    args: (s) => ({ windowDays: s.windowDays, take: s.take }),
  },
  {
    id: 'students_by_grade',
    tool: 'students_count_by_grade',
    template: 'students_by_grade',
    samples: ['كم طالب في المنصة؟', 'توزيع الطلاب على الصفوف', 'عدد الطلاب'],
    phrases: ['عدد الطلاب', 'كم طالب', 'توزيع الطلاب', 'الطلاب في كل صف', 'طلاب الصف', 'الطلاب حسب الصف'],
    args: () => ({}),
  },
  {
    id: 'students_new_trend',
    tool: 'students_new_trend',
    template: 'students_new_trend',
    samples: ['اتجاه تسجيل الطلاب الجدد', 'الطلاب الجدد آخر 4 أسابيع', 'نمو الطلاب'],
    phrases: ['الطلاب الجدد', 'تسجيل الطلاب الجدد', 'اتجاه التسجيل', 'نمو الطلاب', 'معدل تسجيل الطلاب'],
    args: (s) => ({
      granularity: s.trend && s.trend.granularity,
      periods: s.trend && s.trend.periods,
    }),
  },
  {
    id: 'student_profile',
    tool: 'student_profile_summary',
    template: 'student_profile',
    samples: ['ملف الطالب gedfufdhiish', 'بيانات الطالب gedfufdhiish', 'تفاصيل الطالب gedfufdhiish'],
    phrases: ['ملف الطالب', 'بيانات الطالب', 'بروفايل الطالب', 'تفاصيل الطالب', 'ملخص طالب'],
    requiresSlug: true,
    args: (s) => ({ userSlug: s.slug }),
  },
  {
    id: 'top_students',
    tool: 'student_performance_ranking',
    template: 'top_students',
    samples: ['أفضل 5 طلاب', 'أعلى الطلاب في الدرجات', 'ترتيب الطلاب'],
    phrases: ['افضل الطلاب', 'اعلي الطلاب', 'افضل طلاب', 'اعلي طلاب', 'ترتيب الطلاب', 'الطلاب المتفوقين', 'اعلي درجات', 'افضل درجات'],
    args: (s) => ({ direction: 'top', take: s.take, grade: s.grade }),
  },
  {
    id: 'weak_students',
    tool: 'student_performance_ranking',
    template: 'weak_students',
    samples: ['أضعف 5 طلاب', 'أقل الطلاب في الدرجات', 'الطلاب الضعاف'],
    phrases: ['اضعف الطلاب', 'اقل الطلاب', 'اضعف طلاب', 'اقل طلاب', 'الطلاب الضعاف', 'اقل درجات', 'اسوا الطلاب', 'الطلاب المتعثرين'],
    args: (s) => ({ direction: 'bottom', take: s.take, grade: s.grade }),
  },
  {
    id: 'inactive_students',
    tool: 'inactive_students',
    template: 'inactive_students',
    samples: ['طلاب ما دخلوش من 14 يوم', 'الطلاب غير النشطين', 'منقطع من 30 يوم'],
    phrases: ['غير النشطين', 'غير نشطين', 'طلاب منقطعين', 'المنقطعين', 'منقطع', 'متوقف', 'متوقفين', 'خامل', 'خاملين', 'لم يتفاعل', 'ما دخلوش'],
    // Single tokens are allowed here because they are domain-unique ("منقطع" can
    // only mean an inactive student in an admin's question).
    minScore: 1,
    args: (s) => ({ inactiveDays: s.inactiveDays, take: s.take }),
  },
  {
    id: 'courses_list',
    tool: 'courses_list',
    template: 'courses_list',
    samples: ['قائمة الدورات', 'الدورات المتاحة', 'الكورسات الموجودة'],
    phrases: ['قائمه الدورات', 'الدورات المتاحه', 'قائمه الكورسات', 'الكورسات المتاحه', 'الدورات الموجوده', 'الكورسات الموجوده'],
    args: (s) => ({ grade: s.grade, take: s.take }),
  },
  {
    id: 'course_detail',
    tool: 'course_detail',
    template: 'course_detail',
    samples: ['تفاصيل الكورس k8ity07q25xc', 'بيانات الدورة k8ity07q25xc', 'معلومات الكورس k8ity07q25xc'],
    phrases: ['تفاصيل الكورس', 'تفاصيل الدوره', 'بيانات الكورس', 'بيانات الدوره', 'معلومات الكورس', 'ملف الكورس'],
    requiresSlug: true,
    args: (s) => ({ courseSlug: s.slug }),
  },
  {
    id: 'course_completion_rates',
    tool: 'course_completion_rates',
    template: 'course_completion_rates',
    samples: ['نسب إكمال الدورات', 'معدل الإكمال', 'نسبة الإكمال في الكورسات'],
    phrases: ['نسب الاكمال', 'معدل الاكمال', 'اكمال الدورات', 'نسبه الاكمال', 'نسب اكمال', 'اكملو الدورات'],
    args: (s) => ({ grade: s.grade, take: s.take }),
  },
  {
    id: 'courses_by_grade',
    tool: 'courses_by_grade',
    template: 'courses_by_grade',
    samples: ['توزيع الدورات على الصفوف', 'دورات كل صف', 'الكورسات حسب الصف'],
    phrases: ['توزيع الدورات', 'دورات كل صف', 'الكورسات بالصف', 'الكورسات حسب الصف', 'الدورات حسب الصف', 'الدورات بالصف', 'توزيع الكورسات'],
    args: () => ({}),
  },
  {
    id: 'video_pipeline_status',
    tool: 'video_pipeline_status',
    template: 'video_pipeline_status',
    samples: ['حالة معالجة الفيديوهات', 'الفيديوهات العالقة', 'فيديوهات باني الفاشلة'],
    phrases: ['حاله الفيديوهات', 'الفيديوهات العالقه', 'معالجه الفيديوهات', 'فيديوهات فاشله', 'فشل الرفع', 'فيديو عالق', 'فيديوهات باني'],
    args: (s) => ({ staleMinutes: s.staleMinutes, take: s.take }),
  },
  {
    id: 'video_engagement',
    tool: 'video_engagement',
    template: 'video_engagement',
    samples: ['تفاعل الطلاب مع الفيديوهات', 'أكثر الفيديوهات مشاهدة', 'نسب مشاهدة الفيديوهات'],
    phrases: ['تفاعل الفيديوهات', 'تفاعل الطلاب', 'اكثر مشاهده', 'نسب المشاهده', 'مشاهده الفيديوهات', 'اكثر الفيديوهات مشاهده', 'المشاهدات'],
    args: (s) => ({ take: s.take, courseSlug: s.hasCourseWord ? s.slug : null }),
  },
  {
    id: 'quiz_list',
    tool: 'quiz_list',
    template: 'quiz_list',
    samples: ['قائمة الاختبارات', 'الاختبارات المتاحة', 'عدد الاختبارات'],
    phrases: ['قائمه الاختبارات', 'الاختبارات المتاحه', 'الاختبارات الموجوده', 'عدد الاختبارات'],
    args: (s) => ({ take: s.take, courseSlug: s.hasCourseWord ? s.slug : null }),
  },
  {
    id: 'quiz_pass_rates',
    tool: 'quiz_pass_rates',
    template: 'quiz_pass_rates',
    samples: ['نسب النجاح في الاختبارات', 'معدل النجاح', 'نتائج الاختبارات آخر 90 يوم'],
    phrases: ['نسب النجاح', 'معدل النجاح', 'نتائج الاختبارات', 'نسبه النجاح', 'النجاح في الاختبارات'],
    args: (s) => ({ windowDays: s.windowDays, take: s.take, courseSlug: s.hasCourseWord ? s.slug : null }),
  },
  {
    id: 'quiz_attempts',
    tool: 'quiz_attempt_search',
    template: 'quiz_attempts',
    samples: ['محاولات الاختبارات', 'آخر المحاولات', 'محاولات قيد التصحيح'],
    phrases: ['محاولات الاختبارات', 'المحاولات', 'محاولات', 'محاولات الطلاب', 'محاولات اختبار', 'اخر المحاولات', 'محاولات قيد التصحيح'],
    // "محاولات" alone is unambiguous in this domain — an admin saying it means
    // quiz attempts, never anything else.
    minScore: 1,
    args: (s) => ({ status: s.status, windowDays: s.windowDays, take: s.take }),
  },
  {
    id: 'quiz_difficulty',
    tool: 'quiz_difficulty_ranking',
    template: 'quiz_difficulty',
    samples: ['أصعب الاختبارات', 'ترتيب الاختبارات حسب الصعوبة', 'نسبة الرسوب في الاختبارات'],
    phrases: ['اصعب الاختبارات', 'الاختبارات الاصعب', 'نسبه الرسوب', 'صعوبه الاختبارات', 'الرسوب', 'ترتيب الاختبارات'],
    args: (s) => ({ take: s.take }),
  },
  {
    id: 'grading_backlog',
    tool: 'grading_backlog',
    template: 'grading_backlog',
    samples: ['مهام التصحيح المعلقة', 'تراكم التصحيح', 'المراجعة المعلقة'],
    phrases: ['مهام التصحيح', 'تراكم التصحيح', 'المراجعه المعلقه', 'التصحيح المعلق', 'معلق للتصحيح', 'بانتظار التصحيح', 'المعلقه للتصحيح'],
    args: (s) => ({ take: s.take }),
  },
  {
    id: 'ai_grading_stats',
    tool: 'ai_grading_stats',
    template: 'ai_grading_stats',
    samples: ['إحصائيات التصحيح الآلي', 'أداء المصحح الذكي', 'دقة التصحيح الآلي'],
    phrases: ['التصحيح الالي', 'المصحح الذكي', 'الذكاء الاصطناعي', 'دقه التصحيح', 'مهام التصحيح الالي', 'اداء المصحح'],
    args: (s) => ({ windowDays: s.windowDays }),
  },
  {
    id: 'essay_turnaround',
    tool: 'essay_grading_turnaround',
    template: 'essay_turnaround',
    samples: ['زمن تصحيح المقالات', 'متوسط تصحيح الأسئلة المقالية', 'كم يستغرق التصحيح؟'],
    phrases: ['زمن التصحيح', 'تصحيح المقالات', 'تصحيح الاسئله المقاليه', 'المقاليه', 'يستغرق التصحيح', 'سرعه التصحيح', 'وقت تصحيح'],
    args: (s) => ({ windowDays: s.windowDays }),
  },
  {
    id: 'enrollment_stats',
    tool: 'enrollment_stats',
    template: 'enrollment_stats',
    samples: ['إحصائيات الاشتراكات', 'عدد الاشتراكات', 'الاشتراكات المدفوعة آخر 30 يوم', 'اشتراكات أولى ثانوي'],
    phrases: ['احصائيات الاشتراكات', 'عدد الاشتراكات', 'اشتراكات', 'الاشتراكات المدفوعه', 'اجمالي الاشتراكات', 'اشتراكات المنصه', 'الاشتراكات غير المدفوعه'],
    // "اشتراكات" alone is a platform-level word (per-course breakdowns say
    // "اشتراكات الدورات" — a 2-token phrase that outranks this single token).
    minScore: 1,
    args: (s) => ({ windowDays: s.windowDays, grade: s.grade, courseSlug: s.hasCourseWord ? s.slug : null }),
  },
  {
    id: 'enrollment_trend',
    tool: 'enrollment_trend',
    template: 'enrollment_trend',
    samples: ['اتجاه الاشتراكات', 'الاشتراكات الجديدة آخر 4 أسابيع', 'نمو الاشتراكات'],
    phrases: ['اتجاه الاشتراكات', 'نمو الاشتراكات', 'الاشتراكات الجديده', 'اشتراكات جديده', 'معدل الاشتراك'],
    args: (s) => ({
      granularity: s.trend && s.trend.granularity,
      periods: s.trend && s.trend.periods,
    }),
  },
  {
    id: 'enrollment_by_course',
    tool: 'enrollment_by_course',
    template: 'enrollment_by_course',
    samples: ['اشتراكات كل كورس', 'أداء الدورات', 'إيرادات الدورات'],
    phrases: ['اشتراكات كل كورس', 'ايرادات الدورات', 'اداء الدورات', 'اشتراكات الدورات', 'مقارنه الدورات', 'اشتراكات الكورسات'],
    args: (s) => ({ grade: s.grade, take: s.take }),
  },
  {
    id: 'revenue_summary',
    tool: 'revenue_summary',
    template: 'revenue_summary',
    samples: ['ملخص الإيرادات', 'كم دخل المنصة؟', 'إجمالي الإيرادات آخر 30 يوم'],
    phrases: ['ملخص الايرادات', 'اجمالي الايرادات', 'الايرادات', 'ايرادات', 'الدخل', 'دخل', 'الارباح', 'ربح', 'المبيعات'],
    // Money words are domain-unique, so one of them alone is enough to answer.
    minScore: 1,
    args: (s) => ({ windowDays: s.windowDays }),
  },
  {
    id: 'payment_issues',
    tool: 'payment_issues',
    template: 'payment_issues',
    samples: ['مشاكل الدفع', 'المدفوعات الفاشلة', 'فشل الدفع آخر أسبوع'],
    phrases: ['مشاكل الدفع', 'المدفوعات الفاشله', 'فشل الدفع', 'عمليات فاشله', 'مشكله في الدفع', 'الدفع الفاشله'],
    args: (s) => ({ windowDays: s.windowDays, take: s.take }),
  },
  {
    id: 'notification_stats',
    tool: 'notification_stats',
    template: 'notification_stats',
    samples: ['إحصائيات الإشعارات', 'إشعارات الطلاب', 'حالة الإشعارات'],
    phrases: ['احصائيات الاشعارات', 'اشعارات الطلاب', 'حاله الاشعارات', 'الرسائل المرسله', 'الاشعارات'],
    args: (s) => ({ windowDays: s.windowDays, take: s.take }),
  },
  {
    id: 'admin_audit_recent',
    tool: 'admin_audit_recent',
    template: 'admin_audit_recent',
    samples: ['سجل التدقيق', 'أحدث العمليات الإدارية', 'آخر التغييرات'],
    phrases: ['سجل التدقيق', 'العمليات الاداريه', 'اخر التغييرات', 'التغييرات الاخيره', 'سجل العمليات', 'النشاط الاداري'],
    args: (s) => ({ windowDays: s.windowDays, take: s.take }),
  },
];

module.exports = {
  route,
  INTENTS,
  // Reused by the answer layer and by tests. The agentic tier (Phase 3) reuses
  // the same parsers, so a window or grade means exactly the same thing there as
  // it does on the fast path — one definition, two tiers.
  normalize,
  tokenize,
  extractSlots,
  extractWindowDays,
  extractGrade,
  extractTake,
  extractTrend,
};




