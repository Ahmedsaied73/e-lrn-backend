const prisma = require('../config/db');
const cache = require('../integrations/redis/cache');
const { isAdmin } = require('../middlewares');
const { evaluateGate, invalidateQuizMeta, invalidateGateForUser } = require('../services/quizService');

function parseBunnyVideoId(value) {
  const videoId = Number(value);
  return Number.isSafeInteger(videoId) && videoId > 0 ? videoId : null;
}

/**
 * Mark a video as completed for the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const markVideoCompleted = async (req, res) => {
  try {
    const videoId = parseBunnyVideoId(req.body?.videoId);
    if (!videoId) return res.status(400).json({ error: 'Invalid video ID format' });

    // The sequential gate is the single source of truth: it enforces
    // enrollment + previous-video-completion (and quiz pass). Admins bypass it.
    const gate = await evaluateGate(req.user.id, videoId, req.user.role);
    if (!gate.allowed) {
      if (gate.code === 'VIDEO_NOT_FOUND') {
        return res.status(404).json({ error: 'Video not found', code: 'VIDEO_NOT_FOUND' });
      }
      if (gate.code === 'NOT_ENROLLED') {
        return res.status(403).json({ error: gate.reason, code: 'NOT_ENROLLED' });
      }
      return res.status(403).json({
        error: gate.reason,
        code: 'VIDEO_NOT_UNLOCKED',
        previousVideoId: gate.previousVideoId,
      });
    }

    const videoProgress = await prisma.bunnyVideoProgress.upsert({
      where: { userId_bunnyVideoId: { userId: req.user.id, bunnyVideoId: videoId } },
      update: { completed: true, watchedAt: new Date() },
      create: { userId: req.user.id, bunnyVideoId: videoId, completed: true },
    });

    // Sync enrollment progress/percentage (admins have no enrollment row).
    // The gate result already carries courseId (`gate._video`) — no extra
    // video.findUnique here. enrollment + both counts are independent once the
    // upsert above committed (the counts must observe the just-written row,
    // so they batch AFTER the upsert, not alongside it).
    if (!(await isAdmin(req))) {
      const courseId = gate._video && gate._video.courseId;
      // Defensive: the gate always returns `_video` for non-admin allowed
      // results (student paths return { allowed, _video } — see quizService
      // evaluateGate). If a future gate change drops it, skip the enrollment
      // sync rather than emit an 'undefined' cache key / silently match-less
      // findFirst. The progress row above is still written — grading and the
      // sequential gate for video N+1 do not depend on Enrollment.progress.
      if (courseId) {
        // Per-user course page cache (courses/controllers getCourseById) — a
        // completion flips `progress` in that payload; drop the key now so the
        // student's next course-page load reflects it (not up to 60s stale).
        const courseCacheKey = cache.buildKey('courses', 'byid', courseId, `u${req.user.id}`);
        await cache.del(courseCacheKey);
        const [enrollment, totalVideos, completedVideos] = await Promise.all([
          prisma.enrollment.findFirst({
            where: { userId: req.user.id, courseId },
          }),
          prisma.bunnyVideo.count({ where: { courseId, status: 'READY' } }),
          prisma.bunnyVideoProgress.count({
            where: { userId: req.user.id, completed: true, bunnyVideo: { courseId, status: 'READY' } },
          }),
        ]);

        if (enrollment) {
          const completed = totalVideos > 0 && completedVideos === totalVideos;
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: {
              progress: totalVideos ? (completedVideos / totalVideos) * 100 : 0,
              lastAccess: new Date(),
              isCompleted: completed,
              completedAt: completed ? new Date() : null,
            },
          });
        }
      }
    }

    // Completion flips the quiz meta `unlocked` flag — drop its cache.
    // (invalidateQuizMeta never throws by contract.) Completing video N unlocks
    // video N+1's gate — invalidate all gate results for this user so
    // downstream gates reflect the new progress. Both are independent Redis
    // ops; batch them.
    await Promise.all([
      invalidateQuizMeta(req.user.id, videoId),
      invalidateGateForUser(req.user.id),
    ]);

    return res.json({
      message: 'Video marked as completed',
      videoProgress
    });
  } catch (error) {
    console.error('Error marking video as completed:', error);
    res.status(500).json({ error: 'Failed to mark video as completed' });
  }
};

/**
 * Check if a video has been completed by the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const checkVideoCompletion = async (req, res) => {
  try {
    const videoId = parseBunnyVideoId(req.params.videoId);
    if (!videoId) return res.status(400).json({ error: 'Invalid video ID format' });

    // Enrollment gate — mirrors markVideoCompleted/evaluateGate so progress
    // cannot be probed for videos in courses the user isn't enrolled in.
    const video = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      select: { courseId: true },
    });
    if (!video) return res.status(404).json({ error: 'Video not found' });

    if (!(await isAdmin(req))) {
      const enrollment = await prisma.enrollment.findFirst({
        where: { userId: req.user.id, courseId: video.courseId },
        select: { id: true },
      });
      if (!enrollment) {
        return res.status(403).json({
          error: 'You must be enrolled in this course to access this video',
          code: 'NOT_ENROLLED',
        });
      }
    }

    const videoProgress = await prisma.bunnyVideoProgress.findUnique({
      where: { userId_bunnyVideoId: { userId: req.user.id, bunnyVideoId: videoId } },
    });

    // Return completion status
    res.json({
      videoId,
      completed: videoProgress ? videoProgress.completed : false,
      watchedAt: videoProgress ? videoProgress.watchedAt : null
    });
  } catch (error) {
    console.error('Error checking video completion:', error);
    res.status(500).json({ error: 'Failed to check video completion status' });
  }
};

/**
 * Get all completed videos for a course by the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const getCourseVideoProgress = async (req, res) => {
  try {
    const courseId = parseBunnyVideoId(req.params.courseId);
    if (!courseId) return res.status(400).json({ error: 'Invalid course ID format' });

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: { bunnyVideos: { where: { status: 'READY' }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } }
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Enrollment gate — mirrors markVideoCompleted/evaluateGate.
    if (!(await isAdmin(req))) {
      const enrollment = await prisma.enrollment.findFirst({
        where: { userId: req.user.id, courseId },
        select: { id: true },
      });
      if (!enrollment) {
        return res.status(403).json({
          error: 'You must be enrolled in this course to view progress',
          code: 'NOT_ENROLLED',
        });
      }
    }

    const videoIds = course.bunnyVideos.map(video => video.id);
    const videoProgress = await prisma.bunnyVideoProgress.findMany({
      where: {
        userId: req.user.id,
        bunnyVideoId: { in: videoIds }
      }
    });

    // Create a map of video ID to completion status
    const progressMap = {};
    videoProgress.forEach(progress => {
      progressMap[progress.bunnyVideoId] = {
        completed: progress.completed,
        watchedAt: progress.watchedAt
      };
    });

    // Create the response with all videos and their completion status
    const videosWithProgress = course.bunnyVideos.map(video => ({
      id: video.id,
      title: video.title,
      duration: video.duration,
      completed: progressMap[video.id] ? progressMap[video.id].completed : false,
      watchedAt: progressMap[video.id] ? progressMap[video.id].watchedAt : null
    }));

    res.json({
      courseId,
      totalVideos: course.bunnyVideos.length,
      completedVideos: Object.values(progressMap).filter(p => p.completed).length,
      videos: videosWithProgress
    });
  } catch (error) {
    console.error('Error getting course video progress:', error);
    res.status(500).json({ error: 'Failed to get course video progress' });
  }
};

module.exports = {
  markVideoCompleted,
  checkVideoCompletion,
  getCourseVideoProgress
};
