'use strict';
// Keep identical in semantics to frontend copy: lib/subjectProfile.ts

const PROFILES = {
  MATH: { defaultFormat: 'RICH', allowChem: false },
  PHYSICS: { defaultFormat: 'RICH', allowChem: false },
  CHEMISTRY: { defaultFormat: 'RICH', allowChem: true },
  ARABIC: { defaultFormat: 'PLAIN', allowChem: false },
  ENGLISH: { defaultFormat: 'PLAIN', allowChem: false },
  PLAIN_KNOWN: { defaultFormat: 'PLAIN', allowChem: false },
};

const warnedSubjects = new Set();

function normalizeSubjectKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const upper = s.toUpperCase();
  if (PROFILES[upper]) return upper;

  // Arabic & English aliases across all ثانوية عامة subjects
  if (
    /^(ال)?رياض(ة|يات)(\s+(بحتة|تطبيقية))?$/i.test(s) ||
    /^(ال)?(تفاضل|تكامل|جبر|هندسة|استاتيكا|ديناميكا|ميكانيكا|إحصاء|احصاء)(\s+و(ال)?(تكامل|هندسة(\s+فراغية)?))?$/i.test(s) ||
    upper === 'MATHS' || upper === 'MATHEMATICS' || upper === 'STATISTICS'
  ) return 'MATH';
  if (/^(ال)?فيزياء$/i.test(s)) return 'PHYSICS';
  if (/^(ال)?كيمياء$/i.test(s)) return 'CHEMISTRY';
  if (/^(اللغة\s+)?(ال)?عربي(ة)?$/i.test(s) || /^عربي$/i.test(s)) return 'ARABIC';
  if (/^(اللغة\s+)?(ال)?(إ|ا)نجليزي(ة)?$/i.test(s) || /^(إ|ا)نجليزي$/i.test(s)) return 'ENGLISH';
  if (
    /^(ال)?(أحياء|احياء)$/i.test(s) || upper === 'BIOLOGY' ||
    /^(ال)?جيولوجيا(\s+وعلوم\s+بيئية)?$/i.test(s) || upper === 'GEOLOGY' ||
    /^(اللغة\s+)?(ال)?فرنسي(ة)?$/i.test(s) || /^فرنساوي$/i.test(s) || upper === 'FRENCH' ||
    /^(اللغة\s+)?(ال)?ألماني(ة)?$/i.test(s) || /^(أ|ا)لماني$/i.test(s) || upper === 'GERMAN' ||
    /^(اللغة\s+)?(ال)?إيطالي(ة)?$/i.test(s) || /^(إ|ا)يطالي$/i.test(s) || upper === 'ITALIAN' ||
    /^(اللغة\s+)?(ال)?إسباني(ة)?$/i.test(s) || upper === 'SPANISH' ||
    /^(ال)?تاريخ$/i.test(s) || upper === 'HISTORY' ||
    /^(ال)?جغرافيا$/i.test(s) || upper === 'GEOGRAPHY' ||
    /^(ال)?فلسفة(\s+ومنطق)?$/i.test(s) || upper === 'PHILOSOPHY' ||
    /^علم\s+(ال)?نفس(\s+و(ال)?اجتماع)?$/i.test(s) || upper === 'PSYCHOLOGY'
  ) return 'PLAIN_KNOWN';

  return null;
}

/**
 * Returns the subject profile for a given subject.
 * Pure function: depends only on the subject string, never on UI locale.
 *
 * @param {string | null | undefined} subject
 * @returns {{ defaultFormat: 'PLAIN' | 'RICH', allowChem: boolean }}
 */
function subjectProfile(subject) {
  const key = normalizeSubjectKey(subject);
  if (key && PROFILES[key]) {
    return PROFILES[key];
  }

  const trimmed = typeof subject === 'string' ? subject.trim() : '';
  if (trimmed && !warnedSubjects.has(trimmed)) {
    console.warn(`[subjectProfile] Unknown subject "${trimmed}", falling back to PLAIN profile`);
    warnedSubjects.add(trimmed);
  }

  return { defaultFormat: 'PLAIN', allowChem: false };
}

/**
 * Gets active deployment subject from environment.
 *
 * @returns {string}
 */
function getActiveSubject() {
  return process.env.AI_STUDENT_SUBJECT || process.env.NEXT_PUBLIC_SUBJECT_NAME || 'ARABIC';
}

/**
 * Resolves the effective format for an essay question.
 * If question has an explicit format ('PLAIN' or 'RICH'), that explicit choice wins.
 * Otherwise, falls back to the deployment/subject profile default format.
 *
 * @param {'PLAIN' | 'RICH' | null | undefined} answerFormat - Stored question format
 * @param {string} [subject] - Optional subject override
 * @returns {'PLAIN' | 'RICH'}
 */
function resolveEffectiveFormat(answerFormat, subject = getActiveSubject()) {
  if (answerFormat === 'PLAIN' || answerFormat === 'RICH') {
    return answerFormat;
  }
  return subjectProfile(subject).defaultFormat;
}

module.exports = {
  PROFILES,
  subjectProfile,
  getActiveSubject,
  resolveEffectiveFormat,
};
