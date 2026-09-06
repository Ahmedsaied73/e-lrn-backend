const prisma = require('../config/db');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');

// Get all courses (with pagination)
const getAllCourses = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();

    const where = search ? { title: { contains: search } } : {};

    const [courses, total] = await Promise.all([
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

    // Single Prisma call: videos + this user's progress per video + this user's
    // enrollment (if any) are all fetched via filtered relation includes, so no
    // additional per-video or per-user round trips are needed (no N+1).
    const course = await prisma.course.findUnique({
      where: { id: parseInt(id) },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        videos: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            url: true,
            thumbnail: true,
            duration: true,
            position: true,
            // Scoped to the authenticated user only
            videoProgress: {
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

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    if (course.thumbnail && !course.thumbnail.startsWith('http')) {
      course.thumbnail = `${baseUrl}/${course.thumbnail}`;
    }

    // Derive videos + progress from the same fetched relation (no extra queries)
    const videos = course.videos.map(({ videoProgress, ...video }) => ({
      ...video,
      url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
      thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail
    }));

    // Existing "no progress record" representation (see videoProgressController):
    // completed: false, watchedAt: null
    const progress = course.videos.map(video => ({
      videoId: video.id,
      completed: video.videoProgress[0] ? video.videoProgress[0].completed : false,
      watchedAt: video.videoProgress[0] ? video.videoProgress[0].watchedAt : null
    }));

    const enrollment = course.enrollments[0] || null;

    const { videos: _rawVideos, enrollments: _rawEnrollments, ...courseData } = course;

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

    const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (!validGrades.includes(grade)) {
      return res.status(400).json({ success: false, error: 'Invalid grade value' });
    }

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' }
    });

    if (!admin) {
      return res.status(500).json({ success: false, error: 'Administrator account not found' });
    }

    const course = await prisma.course.create({
      data: {
        title,
        description,
        price: parseFloat(price),
        grade,
        category: category || undefined,
        thumbnail: thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
        teacherId: admin.id
      }
    });

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

    const existingCourse = await prisma.course.findUnique({
      where: { id: parseInt(id) }
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
      price: price !== undefined ? parseFloat(price) : undefined,
      grade: grade || undefined,
      category: category || undefined,
      thumbnail: thumbnail || undefined
    };

    const updatedCourse = await prisma.course.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    res.json({ success: true, message: 'Course updated successfully', data: updatedCourse });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ success: false, error: 'Failed to update course' });
  }
};

// Delete a course
const deleteCourse = async (req, res) => {
  try {
    const courseId = parseInt(req.params.id);

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
