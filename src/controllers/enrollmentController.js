const prisma = require('../config/db');

/**
 * Enroll the authenticated user in a course.
 * userId is always derived from the JWT token — never from the request body.
 */
const enrollUserInCourse = async (req, res) => {
  try {
    const userId = req.user.id; // [C-8] Derived from token, not body
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ success: false, error: 'Course ID is required.' });
    }

    const parsedCourseId = parseInt(courseId, 10);
    if (isNaN(parsedCourseId)) {
      return res.status(400).json({ success: false, error: 'Invalid course ID format.' });
    }

    // Verify the course exists
    const course = await prisma.course.findUnique({
      where: { id: parsedCourseId },
      select: { id: true, price: true }
    });

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }

    // Check if already enrolled
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId: parsedCourseId }
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
          data: { enrollment: updatedEnrollment }
        });
      }
      return res.status(409).json({ success: false, error: 'Already enrolled in this course.' });
    }

    // Payment is disabled for now — all enrollments are auto-marked as paid
    const isPaid = true;

    const enrollment = await prisma.enrollment.create({
      data: {
        userId,
        courseId: parsedCourseId,
        isPaid,
        paymentDate: new Date(),
        startedAt: new Date(),
        lastAccess: new Date()
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Enrollment successful!',
      data: { enrollment }
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
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ success: false, error: 'Course ID is required.' });
    }

    const parsedCourseId = parseInt(courseId, 10);
    if (isNaN(parsedCourseId)) {
      return res.status(400).json({ success: false, error: 'Invalid course ID format.' });
    }

    const enrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId: parsedCourseId }
    });

    return res.status(200).json({
      success: true,
      data: {
        enrolled: !!enrollment,
        enrollment: enrollment || null
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
 * ?page= &limit= &userId= &courseId= &isPaid= &isCompleted= &search= (student name/email or course title)
 */
const listAllEnrollments = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const take = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const skip = (page - 1) * take;

    const where = {};
    const userId = parsePositiveInt(req.query.userId);
    if (userId) where.userId = userId;
    const courseId = parsePositiveInt(req.query.courseId);
    if (courseId) where.courseId = courseId;
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
          user: { select: { id: true, name: true, email: true, grade: true } },
          course: { select: { id: true, title: true, grade: true } },
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
 * Body: { userId, courseId }. Auto-paid (payment disabled platform-wide).
 */
const adminEnroll = async (req, res) => {
  try {
    const { userId, courseId } = req.body;
    const parsedUserId = parsePositiveInt(userId);
    const parsedCourseId = parsePositiveInt(courseId);

    if (!parsedUserId || !parsedCourseId) {
      return res.status(400).json({ success: false, error: 'userId and courseId are required.' });
    }

    const user = await prisma.user.findUnique({ where: { id: parsedUserId }, select: { id: true, role: true } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const course = await prisma.course.findUnique({ where: { id: parsedCourseId }, select: { id: true } });
    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found.' });
    }

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

    return res.status(201).json({
      success: true,
      message: 'Student enrolled successfully.',
      data: { enrollment },
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

    const enrollment = await prisma.enrollment.findUnique({ where: { id }, select: { id: true } });
    if (!enrollment) {
      return res.status(404).json({ success: false, error: 'Enrollment not found.' });
    }

    await prisma.enrollment.delete({ where: { id } });

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
