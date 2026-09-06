'use strict';

/**
 * adminController.js
 *
 * Cross-domain aggregates for the admin console. Per-domain admin operations
 * live in their home controllers (userController, quizController,
 * enrollmentController, ...). This file only glues dashboard counts and
 * alert lists so the admin Overview page gets one request instead of many.
 */

const prisma = require('../config/db');

const RECENT_WINDOW_DAYS = 7;
const STALE_PROCESSING_MS = 30 * 60 * 1000;

const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  grade: true,
  role: true,
  createdAt: true,
};

function toMap(grouped) {
  const entries = {};
  for (const { status, _count } of grouped) {
    entries[status] = _count._all;
  }
  return entries;
}

/**
 * GET /admin/dashboard
 * Returns headline counts, operational alerts, and recent activity.
 */
async function getDashboardStats(req, res) {
  try {
    const now = Date.now();
    const sinceWeek = new Date(now - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const staleBefore = new Date(now - STALE_PROCESSING_MS);

    const [
      students,
      admins,
      courses,
      enrollments,
      quizzes,
      attemptsByStatus,
      videosTotal,
      videosByStatus,
      submissionsPending,
      newStudents,
      failedVideos,
      stuckProcessing,
      essaysPending,
      newestUsers,
      newestEnrollments,
      recentAttempts,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT' } }),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.course.count(),
      prisma.enrollment.count(),
      prisma.quiz.count(),
      prisma.quizAttempt.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bunnyVideo.count(),
      prisma.bunnyVideo.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.submission.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { role: 'STUDENT', createdAt: { gte: sinceWeek } } }),
      prisma.bunnyVideo.findMany({
        where: { status: 'FAILED' },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, title: true, courseId: true, failureReason: true, updatedAt: true },
      }),
      prisma.bunnyVideo.findMany({
        where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        orderBy: { updatedAt: 'asc' },
        take: 10,
        select: { id: true, title: true, courseId: true, processingProgress: true, updatedAt: true },
      }),
      prisma.quizAttempt.findMany({
        where: { status: 'GRADING' },
        orderBy: { submittedAt: 'desc' },
        take: 10,
        include: {
          user: { select: safeUserSelect },
          quiz: { select: { id: true, title: true, bunnyVideo: { select: { id: true, title: true } } } },
        },
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: safeUserSelect,
      }),
      prisma.enrollment.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          user: { select: safeUserSelect },
          course: { select: { id: true, title: true, grade: true } },
        },
      }),
      prisma.quizAttempt.findMany({
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: {
          user: { select: safeUserSelect },
          quiz: { select: { id: true, title: true, passingScore: true, bunnyVideo: { select: { title: true } } } },
        },
      }),
    ]);

    const data = {
      counts: {
        students,
        admins,
        courses,
        enrollments,
        quizzes,
        newStudentsLast7d: newStudents,
        attempts: toMap(attemptsByStatus),
        videos: { total: videosTotal, ...toMap(videosByStatus) },
        submissionsPending,
      },
      alerts: {
        failedVideos,
        stuckProcessingVideos: stuckProcessing.map((v) => ({
          ...v,
          stuckMinutes: Math.floor((now - v.updatedAt.getTime()) / 60000),
        })),
        essaysPendingGrading: essaysPending,
        hasIssues: failedVideos.length > 0 || stuckProcessing.length > 0,
      },
      recent: {
        users: newestUsers,
        enrollments: newestEnrollments,
        attempts: recentAttempts,
      },
    };

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('[AdminController] getDashboardStats error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

module.exports = { getDashboardStats };