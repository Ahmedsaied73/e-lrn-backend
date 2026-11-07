'use strict';
// Keep identical in semantics to frontend copy: lib/subjectProfile.ts

const PROFILES = {
  MATH: { defaultFormat: 'RICH', allowChem: false },
  PHYSICS: { defaultFormat: 'RICH', allowChem: false },
  CHEMISTRY: { defaultFormat: 'RICH', allowChem: true },
  ARABIC: { defaultFormat: 'PLAIN', allowChem: false },
  ENGLISH: { defaultFormat: 'PLAIN', allowChem: false },
};

const warnedSubjects = new Set();

function normalizeSubjectKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const upper = s.toUpperCase();
  if (PROFILES[upper]) return upper;

  // Arabic and common aliases
  if (s === 'رياضة' || s === 'رياضيات' || upper === 'MATHS' || upper === 'MATHEMATICS') return 'MATH';
  if (s === 'فيزياء' || s === 'الفيزياء') return 'PHYSICS';
  if (s === 'كيمياء' || s === 'الكيمياء') return 'CHEMISTRY';
  if (s === 'عربي' || s === 'اللغة العربية' || s === 'لغة عربية') return 'ARABIC';
  if (s === 'انجليزي' || s === 'إنجليزي' || s === 'اللغة الإنجليزية') return 'ENGLISH';

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
