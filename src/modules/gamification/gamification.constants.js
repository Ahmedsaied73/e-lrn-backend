'use strict';

const LEVEL_NAMES = ['مستكشف', 'متحمّس', 'مثابر', 'متقن', 'نجم الفصل', 'أسطورة'];
const MAX_LEVEL = 30;

function levelFloor(level) {
  const l = Number(level);
  if (!Number.isFinite(l) || l <= 1) return 0;
  return 50 * l * (l - 1);
}

function levelOf(xp) {
  const safeXp = Math.max(0, Number(xp) || 0);
  let l = 1;
  while (l < MAX_LEVEL && safeXp >= levelFloor(l + 1)) {
    l += 1;
  }
  return l;
}

function levelName(level) {
  const safeLevel = Math.max(1, Number(level) || 1);
  return LEVEL_NAMES[Math.min(safeLevel, LEVEL_NAMES.length) - 1];
}

function progressOf(xp) {
  const safeXp = Math.max(0, Number(xp) || 0);
  const level = levelOf(safeXp);
  const floor = levelFloor(level);
  const next = level >= MAX_LEVEL ? levelFloor(MAX_LEVEL) : levelFloor(level + 1);
  const span = next - floor;
  const pct = span > 0 ? Math.max(0, Math.min(100, Math.round(((safeXp - floor) / span) * 100))) : 100;
  const left = span > 0 ? Math.max(0, next - safeXp) : 0;

  return {
    level,
    levelName: levelName(level),
    pct,
    left,
  };
}

const XP_WEIGHTS = Object.freeze({
  LESSON_COMPLETE: 20,
  STREAK_DAILY: 10,
  QUIZ_CORRECT_PER_Q: 10,
  QUIZ_PERFECT: 30,
  QUIZ_IMPROVEMENT: 20,
});

const BADGE_DEFINITIONS = Object.freeze([
  {
    id: 'first',
    title: 'أول خطوة',
    how: 'أكمل أول درس في أي كورس',
    where: 'بتتفتح لما تحدد الدرس كمكتمل',
    target: 1,
    tone: 'primary',
  },
  {
    id: 'week',
    title: 'نَفَس طويل',
    how: 'ذاكر 7 أيام متتالية',
    where: 'بتتفتح أول نشاط في اليوم السابع',
    target: 7,
    tone: 'accent',
  },
  {
    id: 'perfect',
    title: 'عين الصقر',
    how: 'خد الدرجة النهائية في اختبار',
    where: 'بتظهر في صفحة نتيجة الاختبار',
    target: 1,
    tone: 'accent',
  },
  {
    id: 'steady',
    title: 'صديق المعرفة',
    how: 'أكمل كل دروس الدورة',
    where: 'بتتفتح بعد آخر درس',
    target: 1,
    tone: 'primary',
  },
  {
    id: 'hunter',
    title: 'صايد الأسئلة',
    how: 'أنهِ 3 اختبارات',
    where: 'بتتفتح لما تسلّم الاختبار التالت',
    target: 3,
    tone: 'primary',
  },
  {
    id: 'learner',
    title: 'بتتحسّن',
    how: 'ارفع نتيجتك 10% عن أحسن محاولة ليك',
    where: 'بتظهر بعد إعادة اختبار',
    target: 1,
    tone: 'primary',
  },
  {
    id: 'master',
    title: 'خبير المادة',
    how: 'أتقن تحدي المدرس في الدورة',
    where: 'بتتفتح لما تنجح في التحدي',
    target: 1,
    tone: 'accent',
  },
  {
    id: 'momentum',
    title: 'انطلاقة قوية',
    how: 'اجمع 300 نقطة XP من المذاكرة',
    where: 'بتتفتح تلقائي مع تقدّمك',
    target: 300,
    tone: 'primary',
  },
  {
    id: 'star',
    title: 'قمة التركيز',
    how: 'وصّل المستوى 5',
    where: 'بتتفتح تلقائي مع النقط',
    target: 5,
    tone: 'primary',
  },
]);

const TEACHER_CHALLENGE_PRESETS = Object.freeze({
  MASTERY: {
    id: 'mastery',
    kind: 'MASTERY',
    label: 'إتقان اختبار الوحدة',
    title: 'إتقان اختبار الوحدة',
    rule: 'هات 80٪ أو أكتر في اختبار الوحدة عشان تتقن التحدي.',
    rewardXp: 120,
    masteryPercent: 80,
  },
  STREAK_ANSWERS: {
    id: 'streak_answers',
    kind: 'STREAK_ANSWERS',
    label: 'إجابات صح ورا بعض',
    title: 'تحدي التركيز المتواصل',
    rule: 'جاوب 5 أسئلة صح ورا بعض بدون خطأ في اختبار الوحدة.',
    rewardXp: 100,
    masteryPercent: 80,
  },
  IMPROVE: {
    id: 'improve',
    kind: 'IMPROVE',
    label: 'تحسّن الدرجة',
    title: 'تحدي التطور عن المحاولة السابقة',
    rule: 'ارفع درجتك بنسبة 15٪ على الأقل عن محاولتك الأولى.',
    rewardXp: 90,
    masteryPercent: 75,
  },
  MISTAKES: {
    id: 'mistakes',
    kind: 'MISTAKES',
    label: 'مراجعة الأخطاء',
    title: 'تحدي تصحيح الأخطاء السابقة',
    rule: 'راجع الأسئلة اللي غلطت فيها قبل كده وحلّها صح كلها.',
    rewardXp: 100,
    masteryPercent: 80,
  },
  NO_SKIP: {
    id: 'no_skip',
    kind: 'NO_SKIP',
    label: 'وحدة بدون تخطي',
    title: 'تحدي الالتزام الكامل بالوحدة',
    rule: 'كمّل كل دروس الوحدة بدون تخطي قبل ميعاد الامتحان.',
    rewardXp: 110,
    masteryPercent: 80,
  },
  AI_ESSAY: {
    id: 'ai_essay',
    kind: 'AI_ESSAY',
    label: 'تحسين المقال بالـ AI',
    title: 'تحدي تحسين الإجابة المقالية',
    rule: 'طوّر إجابتك المقالية بعد ملاحظات المصحح الذكي للوصول لـ 85٪.',
    rewardXp: 130,
    masteryPercent: 85,
  },
});

const CAIRO_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function cairoDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return CAIRO_FORMATTER.format(d);
}

function previousCairoDayKey(dayKey) {
  if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return null;
  }
  const [year, month, day] = dayKey.split('-').map(Number);
  const prevUtc = new Date(Date.UTC(year, month - 1, day - 1));
  return prevUtc.toISOString().slice(0, 10);
}

const GRADE_LABELS = Object.freeze({
  FIRST_SECONDARY: 'الصف الأول الثانوي',
  SECOND_SECONDARY: 'الصف الثاني الثانوي',
  THIRD_SECONDARY: 'الصف الثالث الثانوي',
});

module.exports = {
  LEVEL_NAMES,
  MAX_LEVEL,
  levelFloor,
  levelOf,
  levelName,
  progressOf,
  XP_WEIGHTS,
  BADGE_DEFINITIONS,
  TEACHER_CHALLENGE_PRESETS,
  GRADE_LABELS,
  cairoDayKey,
  previousCairoDayKey,
};
