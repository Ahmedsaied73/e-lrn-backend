const prisma = require('../config/db');
const cache = require('../integrations/redis/cache');
const audit = require('../services/auditLog');
const config = require('../config/env');
const { isValidSlug } = require('../utils/slugs');

/**
 * Paywall flag (D6). Read from config only — core never imports the payments
 * module, so deleting src/services/payments leaves this file working.
 * Default OFF preserves today's free-enrollment behavior exactly.
 */
function paymentsOn() {
  return Boolean(config && config.features && config.features.payments && config.paymob && config.paymob.enabled);
}

// Strip numeric course/user references from Enrollment rows — the public
// surface identifies those resources by slug.
function publicEnrollment(enrollment) {
  if (!enrollment) return enrollment;
  const { userId: _uid, courseId: _cid, ...rest } = enrollment;
  return rest;
}

/**
 * Enroll the authenticated user in a course.
 * userId is always derived from the JWT token — never from the request body.
 */
const enrollUserInCourse = async (req, res) => {
  try {
    const userId = req.user.id; // [C-8] Derived from token, not body
    const { courseSlug } = req.body;

    if (!isValidSlug(courseSlug)) {
      return res.status(400).json({ success: false, error: 'Course slug is required.' });
    }

    // Verify the course exists
    const course = await prisma.course.findUnique({
      where: { slug: courseSlug },
      select: { id: true, slug: true, price: true }
    });

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }

    const courseId = course.id;

    // ── Paywall (D6): with payments enabled, a PRICED course can only be
    // entered through a verified payment (the webhook creates the enrollment).
    // Checked BEFORE the existing-enrollment branch so an unpaid row can never
    // be flipped to paid without a payment. Free courses (price <= 0) still
    // enroll directly, and this whole branch is inert while the flag is off.
    if (paymentsOn() && Number(course.price) > 0) {
      return res.status(402).json({
        success: false,
        error: 'This course requires payment.',
        code: 'PAYMENT_REQUIRED',
        data: { courseSlug: course.slug },
      });
    }

    // Check if already enrolled
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId }
    });

    if (existingEnrollment) {
      if (!existingEnrollment.isPaid) {
        const updatedEnrollment = await prisma.enrollment.update({
          where: { id: existingEnrollment.id },
          data: { isPaid: true, paymentDate: new Date() }
        });
        return res.status(200).json({
          success: true,
          message: 'Enrollment updated to active!',
          data: { enrollment: publicEnrollment(updatedEnrollment) }
        });
      }
      return res.status(409).json({ success: false, error: 'Already enrolled in this course.' });
    }

    // Payment is disabled for now — all enrollments are auto-marked as paid
    const isPaid = true;

    const enrollment = await prisma.enrollment.create({
      data: {
        userId,
        courseId,
        isPaid,
        paymentDate: new Date(),
        startedAt: new Date(),
        lastAccess: new Date()
      }
    });

    // New enrollment clears any cached NOT_ENROLLED gate verdict for this user.
    const quizService = require('../services/quizService');
    await quizService.invalidateGateForUser(userId);
    // Achievements aggregate embeds enrolled courses — drop it (never throws).
    await quizService.invalidateAchievementsForUser(userId);
    // Per-user course page cache (courses/controllers getCourseById) — the
    // student's payload carries `enrollment`; drop it so the course page shows
    // their new enrollment on next load.
    await cache.del(cache.buildKey('courses', 'byid', courseId, `u${userId}`));

    return res.status(201).json({
      success: true,
      message: 'Enrollment successful!',
      data: { enrollment: publicEnrollment(enrollment) }
    });
  } catch (error) {
    if (isUniqueError(error)) {
      return res.status(409).json({ success: false, error: 'Already enrolled in this course.' });
    }
    console.error('Enrollment Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

/**
 * Check enrollment status for the authenticated user in a given course.
 */
const checkEnrollmentStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const { courseSlug } = req.body;

    if (!isValidSlug(courseSlug)) {
      return res.status(400).json({ success: false, error: 'Course slug is required.' });
    }

    const course = await prisma.course.findUnique({
      where: { slug: courseSlug },
      select: { id: true },
    });

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }

    const enrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId: course.id }
    });

    return res.status(200).json({
      success: true,
      data: {
        enrolled: !!enrollment,
        enrollment: publicEnrollment(enrollment)
      }
    });
  } catch (error) {
    console.error('Check Enrollment Status Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

const isUniqueError = (error) => error && error.code === 'P2002';

const parsePositiveInt = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseBool = (value) => {
  if (value === undefined || value === null) return undefined;
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return undefined;
};

/**
 * GET /admin/enrollments
 * Admin console: paginated enrollment list with student + course context.
 * ?page= &limit= &userSlug= &courseSlug= &isPaid= &isCompleted= &search= (student name/email or course title)
 */
const listAllEnrollments = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const take = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const skip = (page - 1) * take;

    const where = {};
    const userSlug = (req.query.userSlug || '').trim();
    if (userSlug) {
      const user = await prisma.user.findUnique({
        where: { slug: userSlug },
        select: { id: true },
      });
      if (!user) return res.json({ success: true, data: [], meta: { total: 0, page, limit: take, totalPages: 0 } });
      where.userId = user.id;
    }
    const courseSlug = (req.query.courseSlug || '').trim();
    if (courseSlug) {
      const course = await prisma.course.findUnique({
        where: { slug: courseSlug },
        select: { id: true },
      });
      if (!course) return res.json({ success: true, data: [], meta: { total: 0, page, limit: take, totalPages: 0 } });
      where.courseId = course.id;
    }
    const isPaid = parseBool(req.query.isPaid);
    if (isPaid !== undefined) where.isPaid = isPaid;
    const isCompleted = parseBool(req.query.isCompleted);
    if (isCompleted !== undefined) where.isCompleted = isCompleted;
    const search = (req.query.search || '').trim();
    if (search) {
      where.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { course: { title: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [enrollments, total] = await Promise.all([
      prisma.enrollment.findMany({
        skip,
        take,
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          isPaid: true,
          paymentDate: true,
          progress: true,
          isCompleted: true,
          completedAt: true,
          startedAt: true,
          lastAccess: true,
          createdAt: true,
          user: { select: { id: true, slug: true, name: true, email: true, grade: true } },
          course: { select: { slug: true, title: true, grade: true } },
        },
      }),
      prisma.enrollment.count({ where }),
    ]);

    const data = enrollments.map((e) => ({
      id: e.id,
      student: e.user,
      course: e.course,
      isPaid: e.isPaid,
      paymentDate: e.paymentDate,
      progress: e.progress,
      isCompleted: e.isCompleted,
      completedAt: e.completedAt,
      startedAt: e.startedAt,
      lastAccess: e.lastAccess,
      createdAt: e.createdAt,
    }));

    return res.json({
      success: true,
      data,
      meta: { total, page, limit: take, totalPages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('List All Enrollments Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

/**
 * POST /admin/enrollments
 * Admin enrolls a specific student into a specific course (admin bypass of self-enroll).
 * Body: { userSlug, courseSlug }. Auto-paid (payment disabled platform-wide).
 */
const adminEnroll = async (req, res) => {
  try {
    const { userSlug, courseSlug } = req.body;
    if (!isValidSlug(userSlug) || !isValidSlug(courseSlug)) {
      return res.status(400).json({ success: false, error: 'userSlug and courseSlug are required.' });
    }

    const user = await prisma.user.findUnique({ where: { slug: userSlug }, select: { id: true, role: true } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    const parsedUserId = user.id;

    const course = await prisma.course.findUnique({ where: { slug: courseSlug }, select: { id: true } });
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }
    const parsedCourseId = course.id;

    const existing = await prisma.enrollment.findFirst({
      where: { userId: parsedUserId, courseId: parsedCourseId },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Student is already enrolled in this course.' });
    }

    const enrollment = await prisma.enrollment.create({
      data: {
        userId: parsedUserId,
        courseId: parsedCourseId,
        isPaid: true,
        paymentDate: new Date(),
        startedAt: new Date(),
        lastAccess: new Date(),
      },
    });

    // New enrollment clears any cached NOT_ENROLLED gate verdict for the student.
    const quizService = require('../services/quizService');
    await quizService.invalidateGateForUser(parsedUserId);
    // Achievements aggregate embeds enrolled courses — drop it (never throws).
    await quizService.invalidateAchievementsForUser(parsedUserId);
    await cache.del(cache.buildKey('courses', 'byid', parsedCourseId, `u${parsedUserId}`));

    await audit.record(req, {
      action: 'ENROLL_CREATE',
      targetType: 'enrollment',
      targetId: enrollment.id,
      metadata: { userId: parsedUserId, courseId: parsedCourseId },
    });

    return res.status(201).json({
      success: true,
      message: 'Student enrolled successfully.',
      data: { enrollment: publicEnrollment(enrollment) },
    });
  } catch (error) {
    if (isUniqueError(error)) {
      return res.status(409).json({ success: false, error: 'Student is already enrolled in this course.' });
    }
    console.error('Admin Enroll Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

/**
 * DELETE /admin/enrollments/:id
 * Unenrolls a student from a course. FK-safe: Enrollment has no child relations
 * (Payment/Certificate are keyed on userId, not enrollmentId).
 */
const unenroll = async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, error: 'Invalid enrollment ID.' });
    }

    const enrollment = await prisma.enrollment.findUnique({
      where: { id },
      select: { id: true, userId: true, courseId: true },
    });
    if (!enrollment) {
      return res.status(404).json({ success: false, error: 'Enrollment not found.' });
    }

    await prisma.enrollment.delete({ where: { id } });

    // Removing enrollment revokes video access — invalidate the user's gate cache.
    const quizService = require('../services/quizService');
    await quizService.invalidateGateForUser(enrollment.userId);
    // Achievements aggregate embeds enrolled courses — drop it (never throws).
    await quizService.invalidateAchievementsForUser(enrollment.userId);
    // Per-user course page cache — drop it so the course page stops showing the
    // removed enrollment immediately.
    await cache.del(cache.buildKey('courses', 'byid', enrollment.courseId, `u${enrollment.userId}`));

    await audit.record(req, {
      action: 'ENROLL_DELETE',
      targetType: 'enrollment',
      targetId: enrollment.id,
      metadata: { userId: enrollment.userId, courseId: enrollment.courseId },
    });

    return res.status(200).json({ success: true, message: 'Enrollment removed successfully.' });
  } catch (error) {
    console.error('Unenroll Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

module.exports = {
  enrollUserInCourse,
  checkEnrollmentStatus,
  listAllEnrollments,
  adminEnroll,
  unenroll
};
