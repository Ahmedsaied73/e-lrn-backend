const prisma = require('../config/db');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');
const cache = require('../integrations/redis/cache');

/**
 * Parse a positive-signed 32-bit integer from a route/query param.
 * Returns null when the input is missing, not a safe integer, or non-positive
 * (malformed IDs such as "abc", "1.5", "-1", or overflow otherwise turn into
 * Prisma's P2025/P2030 and a 500 — reject them as 400 here instead).
 */
function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Validate a course price: finite, >= 0, and within a sane ceiling. */
function isInvalidPrice(value) {
  const price = Number(value);
  return !Number.isFinite(price) || price < 0 || price > 1e9;
}

// Get all courses (with pagination)
const getAllCourses = async (req, res) => {
  try {
    const rawPage = parseInt(req.query.page, 10);
    // Clamp page to a safe positive integer (NaN/0/negatives fall back to 1).
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    // Clamp take 1..100 (house pattern): unbounded limits become heavy
    // queries and oversized cache values.
    const rawTake = parseInt(req.query.limit);
    const take = Number.isSafeInteger(rawTake) ? Math.max(1, Math.min(rawTake, 100)) : 20;
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();

    const where = search ? { title: { contains: search, mode: 'insensitive' } } : {};

    // Cache-aside, 90s TTL. Raw rows are cached (host-independent); thumbnail
    // absolutization happens after, per request. Search text is hashed so keys
    // stay bounded regardless of input length.
    const searchHash = search ? cache.shortHash(search) : 'none';
    const cacheKey = cache.buildKey('courses', 'list', `p${page}`, `l${take}`, `s${searchHash}`);
    const { courses, total } = await cache.withCache(cacheKey, 90, async () => {
      const [rows, count] = await Promise.all([
        prisma.course.findMany({
          skip,
          take,
          where,
          include: {
            teacher: {
              select: { id: true, name: true, email: true }
            },
            videos: {
              select: { id: true, title: true, duration: true }
            },
            _count: {
              select: { videos: true, enrollments: true }
            }
          }
        }),
        prisma.course.count({ where })
      ]);
      return { courses: rows, total: count };
    });

    // Ensure thumbnails have full URL if not already
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const coursesWithUrls = courses.map(course => ({
      ...course,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail
    }));

    res.json({
      success: true,
      data: coursesWithUrls,
      meta: {
        total,
        page,
        limit: take,
        totalPages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch courses' });
  }
};

// Get a specific course by ID
// Aggregates everything the Course page needs — course, videos, the authenticated
// user's enrollment, and their video progress (scoped to this course's videos) —
// into one response, so the frontend no longer needs separate calls to
// /enroll/status and per-video progress endpoints for Course init.
const getCourseById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const courseId = parseId(id);
    if (courseId === null) {
      return res.status(400).json({ success: false, error: 'Invalid course ID' });
    }

    // Single Prisma call: videos + this user's progress per video + this user's
    // enrollment (if any) are all fetched via filtered relation includes, so no
    // additional per-video or per-user round trips are needed (no N+1).
    //
    // Cache-aside 60s (P2). IMPORTANT: the payload is user-scoped (progress +
    // enrollment below include `where: { userId }`), so the key MUST carry the
    // userId — a courseId-only key would serve one student's completion state
    // to every other student viewing the same course (cross-user leak). This
    // mirrors the existing per-user quiz-meta cache (quizController). Course
    // create/update/delete already invalidate all `v1:courses:*` keys via
    // delPrefix; enrollment/progress mutations del their own key below.
    const cacheKey = cache.buildKey('courses', 'byid', courseId, `u${userId}`);
    const { course, progress, enrollment } = await cache.withCache(cacheKey, 60, async () => {
      const row = await prisma.course.findUnique({
        where: { id: courseId },
        include: {
          teacher: { select: { id: true, name: true, email: true } },
          // BunnyVideo is the only video system. No `url` is exposed here — a
          // playable link is only ever issued per-request via the signed playback
          // endpoint, never parked in the course payload.
          bunnyVideos: {
            where: { status: 'READY' },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              title: true,
              thumbnailUrl: true,
              duration: true,
              position: true,
              // Scoped to the authenticated user only
              progress: {
                where: { userId },
                select: { completed: true, watchedAt: true }
              }
            }
          },
          // Scoped to the authenticated user only — never expose other users' enrollments
          enrollments: {
            where: { userId }
          }
        }
      });

      if (!row) {
        return null;
      }

      // Existing "no progress record" representation (see videoProgressController):
      // completed: false, watchedAt: null
      const derivedProgress = row.bunnyVideos.map(video => ({
        videoId: video.id,
        completed: video.progress[0] ? video.progress[0].completed : false,
        watchedAt: video.progress[0] ? video.progress[0].watchedAt : null
      }));

      return {
        course: row,
        progress: derivedProgress,
        enrollment: row.enrollments[0] || null
      };
    });

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (course.thumbnail && !course.thumbnail.startsWith('http')) {
      course.thumbnail = `${baseUrl}/${course.thumbnail}`;
    }

    // Derive videos from the fetched course relation (no extra queries).
    // `thumbnailUrl` is mapped onto the legacy `thumbnail` key so the response
    // envelope keeps its shape; `url` is intentionally absent (see above).
    // The per-user `progress` array is dropped per row — it's already surfaced
    // separately in the top-level `progress` list.
    // Thumbnail absolutization is host-dependent → done per request, post-cache.
    const videos = course.bunnyVideos.map(({ progress, thumbnailUrl, ...video }) => ({
      ...video,
      thumbnail: thumbnailUrl && !thumbnailUrl.startsWith('http') ? `${baseUrl}/${thumbnailUrl}` : thumbnailUrl
    }));

    const { bunnyVideos: _rawVideos, enrollments: _rawEnrollments, ...courseData } = course;

    res.json({
      success: true,
      data: {
        course: courseData,
        videos,
        enrollment,
        progress
      }
    });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch course' });
  }
};

// Create a new course (automatically linked to the admin/teacher)
const createCourse = async (req, res) => {
  try {
    const { title, description, price, grade, category, thumbnail } = req.body;

    if (!title || !description || price === undefined || !grade) {
      return res.status(400).json({ success: false, error: 'Title, description, price, and grade are required' });
    }

    if (isInvalidPrice(price)) {
      return res.status(400).json({ success: false, error: 'Invalid price value' });
    }

    const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (!validGrades.includes(grade)) {
      return res.status(400).json({ success: false, error: 'Invalid grade value' });
    }

    // Teacher attribution: use the authenticated ADMIN caller (authorizeAdmin
    // DB-verifies the role before this handler runs). Fall back to the first
    // ADMIN only when no user context is present (direct script invocation).
    let teacherId = req.user ? req.user.id : null;

    if (!teacherId) {
      const admin = await prisma.user.findFirst({
        where: { role: 'ADMIN' }
      });

      if (!admin) {
        return res.status(500).json({ success: false, error: 'Administrator account not found' });
      }
      teacherId = admin.id;
    }

    const course = await prisma.course.create({
      data: {
        title,
        description,
        price: Number(price),
        grade,
        category: category || undefined,
        thumbnail: thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
        teacherId
      }
    });

    await cache.delPrefix('v1:courses:');
    await cache.del(cache.buildKey('search', 'cats'));
    res.status(201).json({ success: true, message: 'Course created successfully', data: course });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ success: false, error: 'Failed to create course' });
  }
};

// Update an existing course
const updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, grade, category, thumbnail } = req.body;

    const courseId = parseId(id);
    if (courseId === null) {
      return res.status(400).json({ success: false, error: 'Invalid course ID' });
    }

    if (price !== undefined && isInvalidPrice(price)) {
      return res.status(400).json({ success: false, error: 'Invalid price value' });
    }

    const existingCourse = await prisma.course.findUnique({
      where: { id: courseId }
    });

    if (!existingCourse) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    if (grade) {
      const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
      if (!validGrades.includes(grade)) {
        return res.status(400).json({ success: false, error: 'Invalid grade value' });
      }
    }

    const updateData = {
      title: title || undefined,
      description: description || undefined,
      price: price !== undefined ? Number(price) : undefined,
      grade: grade || undefined,
      category: category || undefined,
      thumbnail: thumbnail || undefined
    };

    const updatedCourse = await prisma.course.update({
      where: { id: courseId },
      data: updateData
    });

    await cache.delPrefix('v1:courses:');
    await cache.del(cache.buildKey('search', 'cats'));
    res.json({ success: true, message: 'Course updated successfully', data: updatedCourse });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ success: false, error: 'Failed to update course' });
  }
};

// Delete a course
const deleteCourse = async (req, res) => {
  try {
    const courseId = parseId(req.params.id);
    if (courseId === null) {
      return res.status(400).json({ success: false, error: 'Invalid course ID' });
    }

    const existingCourse = await prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        _count: { select: { videos: true, enrollments: true, certificates: true } }
      }
    });

    if (!existingCourse) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    // Collect BunnyVideos for remote cleanup (before DB rows are deleted)
    const bunnyVideos = await prisma.bunnyVideo.findMany({
      where: { courseId },
      select: { bunnyVideoId: true },
    });

    // Quiz rows cascade-delete when BunnyVideos go; snapshot their surveyJsons
    // first so the referenced Storage images can be cleaned up afterwards.
    const quizSurveyJsons = await prisma.quiz
      .findMany({
        where: { bunnyVideo: { courseId } },
        select: { surveyJson: true },
      });

    const quizSurveyJsonList = quizSurveyJsons.map((q) => q.surveyJson);

    await prisma.$transaction(async (prisma) => {
      if (existingCourse._count.videos > 0) {
        await prisma.video.deleteMany({ where: { courseId } });
      }
      
      if (existingCourse._count.enrollments > 0) {
        await prisma.enrollment.deleteMany({ where: { courseId } });
      }
      
      if (existingCourse._count.certificates > 0) {
        await prisma.certificate.deleteMany({ where: { courseId } });
      }
      
      // Update LearningPath associations without causing errors
      await prisma.learningPath.updateMany({
        where: { courses: { some: { id: courseId } } },
        data: {} // This is just to trigger the many-to-many disconnect correctly if needed. Actually we should just fetch paths and disconnect.
      });

      // Fetch paths containing this course
      const paths = await prisma.learningPath.findMany({
        where: { courses: { some: { id: courseId } } },
        select: { id: true }
      });
      
      for (const p of paths) {
        await prisma.learningPath.update({
          where: { id: p.id },
          data: { courses: { disconnect: { id: courseId } } }
        });
      }

      await prisma.course.delete({ where: { id: courseId } });
    });

    // ── Bunny remote cleanup (after DB success) ──────────────────────────────
    // Leave no orphaned videos on Bunny's servers. Errors are logged per-video
    // and do NOT fail the request — the DB delete already succeeded.
    for (const video of bunnyVideos) {
      try {
        await bunnyClient.deleteVideo(video.bunnyVideoId);
      } catch (cleanupErr) {
        console.error(`[deleteCourse] Failed to delete Bunny video ${video.bunnyVideoId}:`, cleanupErr.message);
      }
    }

    // ── Storage cleanup (after DB success) ───────────────────────────────────
    // The cascade already deleted the Quiz rows, so their SurveyJS images are
    // unreferenced. Remove them from the bucket best-effort.
    try {
      const { removeQuizImagesBestEffort } = require('../integrations/supabase/supabaseClient');
      for (const surveyJson of quizSurveyJsonList) {
        await removeQuizImagesBestEffort(surveyJson);
      }
    } catch (cleanupErr) {
      console.error('[deleteCourse] Storage cleanup error:', cleanupErr.message);
    }

    await cache.delPrefix('v1:courses:');
    await cache.delPrefix(`v1:videos:course:${courseId}:`);
    await cache.del(cache.buildKey('search', 'cats'));
    res.json({ success: true, message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ success: false, error: 'Failed to delete course' });
  }
};

// Get courses that a user is enrolled in
const getUserEnrolledCourses = async (req, res) => {
  try {
    const userId = req.user.id;

    const enrollments = await prisma.enrollment.findMany({
      where: { userId },
      include: { course: true }
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const enrolledCourses = enrollments.map(enrollment => {
      const course = enrollment.course;
      if (course.thumbnail && !course.thumbnail.startsWith('http')) {
        course.thumbnail = `${baseUrl}/${course.thumbnail}`;
      }
      return {
        id: enrollment.id,
        createdAt: enrollment.createdAt,
        course
      };
    });

    res.json({ success: true, data: enrolledCourses });
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch enrolled courses' });
  }
};

module.exports = {
  getAllCourses,
  getCourseById,
  createCourse,
  updateCourse,
  deleteCourse,
  getUserEnrolledCourses
};
