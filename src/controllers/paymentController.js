const prisma = require('../config/db');

/**
 * Process a payment for a course
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const processCoursePayment = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { paymentMethod } = req.body;
    const userId = req.user.id;
    
    // Find the course
    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) }
    });
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    // Check if the user is already enrolled
    let enrollment = await prisma.enrollment.findFirst({
      where: {
        userId: userId,
        courseId: parseInt(courseId)
      }
    });
    
    // If already paid, return success but indicate it was already paid
    if (enrollment && enrollment.isPaid) {
      return res.json({
        message: 'Course was already paid for',
        enrollment
      });
    }
    
    // Process payment (in a real app, you would integrate with a payment gateway)
    // This is a simplified example
    const paymentStatus = 'COMPLETED'; // Simulating successful payment
    
    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId: userId,
        amount: course.price,
        status: paymentStatus
      }
    });
    
    // Update or create enrollment with payment info
    if (enrollment) {
      // Update existing enrollment
      enrollment = await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          isPaid: true,
          paymentDate: new Date()
        }
      });
    } else {
      // Create new enrollment with payment
      enrollment = await prisma.enrollment.create({
        data: {
          userId: userId,
          courseId: parseInt(courseId),
          isPaid: true,
          paymentDate: new Date()
        }
      });
    }
    
    res.json({
      message: 'Payment processed successfully',
      payment,
      enrollment
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
};

/**
 * Get payment history for a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getPaymentHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get all payments for the user
    const payments = await prisma.payment.findMany({
      where: { userId: userId },
      orderBy: { createdAt: 'desc' }
    });
    
    // Get all paid enrollments with course details
    const paidEnrollments = await prisma.enrollment.findMany({
      where: {
        userId: userId,
        isPaid: true
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            thumbnail: true,
            price: true
          }
        }
      },
      orderBy: { paymentDate: 'desc' }
    });
    
    // Add full URLs for thumbnails
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formattedEnrollments = paidEnrollments.map(enrollment => ({
      ...enrollment,
      course: {
        ...enrollment.course,
        thumbnail: enrollment.course.thumbnail && !enrollment.course.thumbnail.startsWith('http')
          ? `${baseUrl}/${enrollment.course.thumbnail}`
          : enrollment.course.thumbnail
      }
    }));
    
    res.json({
      payments,
      paidCourses: formattedEnrollments
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
};

module.exports = {
  processCoursePayment,
  getPaymentHistory
}; 