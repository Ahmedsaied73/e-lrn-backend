'use strict';

/**
 * achievementsController.js
 * GET /user/me/achievements — aggregates the authenticated student's course
 * progress and quiz/exam results into a single response for the Achievements
 * page (الانجازات).
 */

const prisma = require('../config/db');
const cache = require('../integrations/redis/cache');

/**
 * GET /user/me/achievements
 * Returns enrolled courses with per-course progress + quiz results summary,
 * plus overall totals (courses, videos, exams taken/passed, average score).
 *
 * Cache-aside, 60s TTL — per-user key (`achievements:{userId}`) because the
 * payload embeds that user's progress + quiz scores. Invalidated by
 * invalidateAchievementsForUser() on every mutation that flips it:
 * video completion, quiz grade, enroll/unenroll.
 */
async function getAchievements(req, res) {
  try {
    const userId = req.user.id;
    const cacheKey = cache.buildKey('achievements', String(userId));

    const payload = await cache.withCache(cacheKey, 60, async () => {
      return buildAchievements(userId);
    });

    return res.status(200).json({ success: true, data: payload });
  } catch (error) {
    console.error('[AchievementsController] getAchievements error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * The Prisma aggregate (enrolled courses + progress + quiz best scores).
 * Split out of the handler so it can sit behind the cache loader.
 */
async function buildAchievements(userId) {
    // Enrolled courses with their READY Bunny videos
    const enrollments = await prisma.enrollment.findMany({
      where: { userId },
      include: {
        course: {
          include: {
            bunnyVideos: {
              where: { status: 'READY' },
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const videoIds = enrollments.flatMap((enrollment) =>
      enrollment.course.bunnyVideos.map((v) => v.id),
    );

    // Completed video records + all quiz attempts for the user across these videos
    const [completedProgress, quizzes] = await Promise.all([
      prisma.bunnyVideoProgress.findMany({
        where: { userId, bunnyVideoId: { in: videoIds }, completed: true },
        select: { bunnyVideoId: true },
      }),
      prisma.quiz.findMany({
        where: { bunnyVideoId: { in: videoIds } },
        include: {
          attempts: {
            where: { userId },
            orderBy: { attemptNumber: 'desc' },
          },
        },
      }),
    ]);

    const completedVideoIds = new Set(completedProgress.map((p) => p.bunnyVideoId));
    const quizByVideo = new Map(quizzes.map((quiz) => [quiz.bunnyVideoId, quiz]));

    const totals = {
      coursesEnrolled: enrollments.length,
      coursesCompleted: 0,
      videosWatched: 0,
      videosTotal: 0,
      examsTaken: 0, // distinct quizzes with at least one non-EXPIRED attempt
      examsPassed: 0,
      gradedExams: 0,
      sumBestScores: 0,
    };

    const courses = enrollments.map(({ course }) => {
      const videos = course.bunnyVideos;
      const watched = videos.filter((v) => completedVideoIds.has(v.id)).length;
      const courseCompleted = videos.length > 0 && watched === videos.length;
      if (courseCompleted) totals.coursesCompleted += 1;
      totals.videosTotal += videos.length;
      totals.videosWatched += watched;

      const exams = course.bunnyVideos
        .map((video) => {
          const quiz = quizByVideo.get(video.id);
          if (!quiz) return null;
          const graded = quiz.attempts.filter((a) => a.status === 'GRADED');
          const best = graded.length
            ? Math.max(...graded.map((a) => a.scorePercent || 0))
            : null;
          const passed = best !== null && best >= quiz.passingScore;
          const attemptsUsed = quiz.attempts.filter((a) => a.status !== 'EXPIRED').length;

          totals.examsTaken += attemptsUsed > 0 ? 1 : 0;
          if (passed) totals.examsPassed += 1;
          if (best !== null) {
            totals.gradedExams += 1;
            totals.sumBestScores += best;
          }

          return {
            videoId: video.id,
            videoSlug: video.slug,
            videoTitle: video.title,
            quizId: quiz.id,
            quizSlug: quiz.slug,
            quizTitle: quiz.title,
            passingScore: quiz.passingScore,
            timeLimitSec: quiz.timeLimitSec,
            maxAttempts: quiz.maxAttempts,
            bestScore: best,
            passed,
            attemptsUsed,
          };
        })
        .filter(Boolean);

      return {
        course: {
          id: course.id,
          slug: course.slug,
          title: course.title,
          description: course.description,
          thumbnail: course.thumbnail,
          grade: course.grade,
        },
        progress: {
          watched,
          total: videos.length,
          percent: videos.length > 0 ? Math.round((watched / videos.length) * 100) : 0,
          completed: courseCompleted,
        },
        exams,
      };
    });

    const averageScore = totals.gradedExams > 0
      ? parseFloat((totals.sumBestScores / totals.gradedExams).toFixed(2))
      : null;

    return {
      totals: {
        coursesEnrolled: totals.coursesEnrolled,
        coursesCompleted: totals.coursesCompleted,
        videosWatched: totals.videosWatched,
        videosTotal: totals.videosTotal,
        examsTaken: totals.examsTaken,
        examsPassed: totals.examsPassed,
        averageScore,
      },
      courses,
    };
}

module.exports = { getAchievements };