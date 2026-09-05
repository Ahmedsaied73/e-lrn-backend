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

module.exports = {
  enrollUserInCourse,
  checkEnrollmentStatus
};
