'use strict';

/**
 * notificationService.js — the ONLY writer/reader of Notification rows.
 *
 * Controllers (and future auto-triggers) call these functions; nobody touches
 * prisma.notification directly. Ownership is enforced by construction: every
 * read/write is scoped to an explicit userId, so one user can never reach
 * another's rows. Recipient lists are always resolved server-side — audience
 * descriptors, never client-supplied user IDs.
 */

const crypto = require('crypto');
const prisma = require('../../config/db');

const NOTIFICATION_TYPES = {
  QUIZ_GRADED: 'QUIZ_GRADED',
  VIDEO_READY: 'VIDEO_READY',
  ADMIN_BROADCAST: 'ADMIN_BROADCAST',
};

const TITLE_MAX = 200;
const BODY_MAX = 5000;
const LINK_MAX = 500;
const FANOUT_CHUNK = 500;
const VALID_GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

/**
 * Navigation targets must be internal app paths. Rejects protocol-relative
 * URLs, schemes, backslashes, and overlong values (open-redirect/XSS guard
 * for the field the frontend turns into a link).
 */
function validateLinkUrl(linkUrl) {
  if (linkUrl === undefined || linkUrl === null || linkUrl === '') return null;
  if (typeof linkUrl !== 'string') throw badRequest('linkUrl must be a string');
  const trimmed = linkUrl.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    throw badRequest('linkUrl must be an internal path starting with /');
  }
  if (/[\\]/.test(trimmed) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed.slice(1))) {
    throw badRequest('linkUrl must be an internal path starting with /');
  }
  if (trimmed.length > LINK_MAX) throw badRequest('linkUrl is too long');
  return trimmed;
}

function validateContent({ title, body }) {
  if (typeof title !== 'string' || !title.trim()) throw badRequest('title is required');
  if (title.trim().length > TITLE_MAX) throw badRequest('title is too long');
  if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > BODY_MAX)) {
    throw badRequest('body is too long');
  }
}

/**
 * Resolve an audience descriptor to student user IDs — server-side only.
 * audience: { kind: 'all' } | { kind: 'course', courseSlug } | { kind: 'grade', grade }
 */
async function resolveAudience(audience) {
  if (!audience || audience.kind === 'all') {
    const users = await prisma.user.findMany({ where: { role: 'STUDENT' }, select: { id: true } });
    return users.map((u) => u.id);
  }
  if (audience.kind === 'course') {
    const { courseSlug } = audience;
    if (typeof courseSlug !== 'string') throw badRequest('Invalid courseSlug');
    const course = await prisma.course.findUnique({ where: { slug: courseSlug }, select: { id: true } });
    if (!course) throw notFound('Course not found');
    const enrollments = await prisma.enrollment.findMany({ where: { courseId: course.id }, select: { userId: true } });
    return enrollments.map((e) => e.userId);
  }
  if (audience.kind === 'grade') {
    if (!VALID_GRADES.includes(audience.grade)) throw badRequest('Invalid grade');
    const users = await prisma.user.findMany({
      where: { role: 'STUDENT', grade: audience.grade },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
  throw badRequest('Invalid audience');
}

/**
 * Fan-out one notification to many users. Returns { count, batchId }.
 * Chunked createMany; safe to call with an empty list (returns count 0).
 */
async function createForUsers({ userIds, type, title, body = null, linkUrl = null, metadata = null, batchId = null }) {
  if (!Object.values(NOTIFICATION_TYPES).includes(type)) throw badRequest('Invalid notification type');
  validateContent({ title, body });
  const safeLink = validateLinkUrl(linkUrl);
  const ids = [...new Set((userIds || []).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const finalBatchId = batchId || crypto.randomUUID();
  let count = 0;
  for (let i = 0; i < ids.length; i += FANOUT_CHUNK) {
    const chunk = ids.slice(i, i + FANOUT_CHUNK).map((userId) => ({
      userId,
      type,
      title: title.trim(),
      body: body || null,
      linkUrl: safeLink,
      metadata: metadata || null,
      batchId: finalBatchId,
    }));
    const created = await prisma.notification.createMany({ data: chunk });
    count += created.count;
  }
  return { count, batchId: finalBatchId };
}

function clampTake(limit) {
  const n = Number(limit);
  if (!Number.isSafeInteger(n)) return 20;
  return Math.max(1, Math.min(n, 100));
}

async function listForUser(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const take = clampTake(limit);
  const pageNum = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const where = unreadOnly ? { userId, read: false } : { userId };
  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (pageNum - 1) * take,
      take,
    }),
    prisma.notification.count({ where }),
  ]);
  return { items, total, page: pageNum, limit: take };
}

async function unreadCount(userId) {
  return prisma.notification.count({ where: { userId, read: false } });
}

async function markRead(userId, id) {
  const notificationId = Number(id);
  if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
    throw badRequest('Invalid notification ID');
  }
  // Scoped update: 0 means missing-or-foreign — indistinguishable by design (no oracle).
  const updated = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true },
  });
  return { updated: updated.count };
}

async function markAllRead(userId) {
  const updated = await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
  return { updated: updated.count };
}

// ─── Automatic triggers (called post-commit, best-effort, never throw) ─────

function moduleOn() {
  try {
    const config = require('../../config/env');
    return !config.features || config.features.notifications !== false;
  } catch {
    return true;
  }
}

/**
 * Notify a student that their quiz attempt was finally graded (MCQ submit,
 * human essay grade, or AI finalize). Call AFTER the GRADED update commits.
 * No-op unless the attempt is GRADED. Never throws.
 */
async function notifyQuizGraded(attemptId) {
  try {
    if (!moduleOn()) return 0;
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: {
        quiz: {
          select: {
            id: true,
            title: true,
            bunnyVideo: { select: { id: true, slug: true, courseId: true, course: { select: { slug: true } } } },
          },
        },
      },
    });
    if (!attempt || attempt.status !== 'GRADED' || !attempt.quiz) return 0;
    const { quiz } = attempt;
    const videoId = quiz.bunnyVideo ? quiz.bunnyVideo.id : null;
    const courseId = quiz.bunnyVideo ? quiz.bunnyVideo.courseId : null;
    const videoSlug = quiz.bunnyVideo ? quiz.bunnyVideo.slug : null;
    const courseSlug = quiz.bunnyVideo && quiz.bunnyVideo.course ? quiz.bunnyVideo.course.slug : null;
    const score = attempt.scorePercent != null ? Math.round(attempt.scorePercent) : null;
    const linkUrl = videoSlug && courseSlug ? `/course/${courseSlug}/video/${videoSlug}/quiz/result/${attempt.id}` : null;
    const { count } = await createForUsers({
      userIds: [attempt.userId],
      type: NOTIFICATION_TYPES.QUIZ_GRADED,
      title: 'نتيجتك جاهزة',
      body: score !== null ? `اختبار "${quiz.title}" — نتيجتك ${score}%` : `اختبار "${quiz.title}" تم تصحيحه`,
      linkUrl,
      metadata: { quizId: quiz.id, videoId, courseId, attemptId: attempt.id },
    });
    return count;
  } catch (err) {
    // R5: outage visibility — still never throws (callers rely on it).
    console.warn('[WARN] notifyQuizGraded failed', { attemptId, error: String((err && err.message) || err).slice(0, 300) });
    return 0;
  }
}

/**
 * Notify enrolled students that a video became watchable. Call AFTER the
 * READY update commits (webhook + reconcile paths). Never throws.
 */
async function notifyVideoReady(videoId) {
  try {
    if (!moduleOn()) return 0;
    const video = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      select: { id: true, slug: true, courseId: true, title: true, status: true, course: { select: { slug: true } } },
    });
    if (!video || video.status !== 'READY') return 0;
    const courseSlug = video.course ? video.course.slug : null;
    const userIds = await resolveAudience({ kind: 'course', courseSlug });
    if (userIds.length === 0) return 0;
    const { count } = await createForUsers({
      userIds,
      type: NOTIFICATION_TYPES.VIDEO_READY,
      title: 'محاضرة جديدة متاحة',
      body: video.title,
      linkUrl: courseSlug ? `/course/${courseSlug}/video/${video.slug}` : null,
      metadata: { videoId: video.id, courseId: video.courseId },
    });
    return count;
  } catch (err) {
    // R5: outage visibility — still never throws (callers rely on it).
    console.warn('[WARN] notifyVideoReady failed', { videoId, error: String((err && err.message) || err).slice(0, 300) });
    return 0;
  }
}

module.exports = {
  NOTIFICATION_TYPES,
  validateLinkUrl,
  resolveAudience,
  createForUsers,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
  notifyQuizGraded,
  notifyVideoReady,
};
