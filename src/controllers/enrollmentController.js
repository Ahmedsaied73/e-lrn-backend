// controllers/enrollmentController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const enrollUserInCourse = async (req, res) => {
  try {
    const { userId, courseId, isPaid } = req.body;

    if (!userId || !courseId) {
      return res.status(400).json({ message: 'User ID and Course ID are required.' });
    }

    // Check if already enrolled
    const existingEnrollment = await prisma.enrollment.findFirst({
      where: { userId: parseInt(userId), courseId: parseInt(courseId) },
    });

    if (existingEnrollment) {
      return res.status(409).json({ message: 'User is already enrolled in this course.' });
    }

    // Create enrollment
    const enrollment = await prisma.enrollment.create({
      data: {
        userId: parseInt(userId),
        courseId: parseInt(courseId),
        isPaid: isPaid || false,
        startedAt: new Date(),
        lastAccess: new Date(),
        createdAt: new Date(),
      },
    });

    return res.status(201).json({
      message: 'Enrollment successful!',
      enrollment: enrollment,
    });
  } catch (error) {
    console.error('Enrollment Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};

const checkEnrollmentStatus = async (req, res) => {
  try {
    const { userId, courseId } = req.body;
    if (!userId || !courseId) {
      return res.status(400).json({ message: 'User ID and Course ID are required.' });
    }
    const enrollment = await prisma.enrollment.findFirst({
      where: { userId: parseInt(userId), courseId: parseInt(courseId) },
    });
    if (enrollment) {
      return res.status(200).json({ enrolled: true, enrollment });
    } else {
      return res.status(200).json({ enrolled: false });
    }
  } catch (error) {
    console.error('Check Enrollment Status Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};

module.exports = {
  enrollUserInCourse,
  checkEnrollmentStatus,
};
