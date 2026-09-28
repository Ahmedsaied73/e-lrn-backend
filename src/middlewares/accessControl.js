// Access control middleware for course content

const prisma = require('../config/db');

/**
 * Middleware to check if a user can access a course's content
 * Admins automatically have access to all courses
 * Regular users need to be enrolled and have paid (for paid courses)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const checkCourseAccess = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const courseId = parseInt(req.params.courseId);
    
    // Check if user is an admin (bypass enrollment check)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });
    
    // Admins have access to all courses
    if (user && user.role === 'ADMIN') {
      return next();
    }
    
    // For regular users, check enrollment
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { price: true }
    });
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        userId: userId,
        courseId: courseId
      }
    });
    
    if (!enrollment) {
      return res.status(403).json({ error: 'You must be enrolled in this course to access content' });
    }
    
    // If course is paid and user hasn't paid, deny access
    if (course.price > 0 && !enrollment.isPaid) {
      return res.status(403).json({ 
        error: 'Payment required to access this content',
        courseId: courseId,
        price: course.price
      });
    }
    
    // All checks passed
    next();
  } catch (error) {
    console.error('Error checking course access:', error);
    res.status(500).json({ error: 'An error occurred while checking access permissions' });
  }
};

/**
 * Middleware to check if a user can access a specific video
 * Uses the same logic as course access but works with videoId
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const checkVideoAccess = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const videoId = parseInt(req.params.videoId);
    
    // Check if user is an admin (bypass enrollment check)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });
    
    // Admins have access to all videos
    if (user && user.role === 'ADMIN') {
      return next();
    }
    
    // For regular users, check enrollment
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        course: {
          select: { id: true, price: true }
        }
      }
    });
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        userId: userId,
        courseId: video.course.id
      }
    });
    
    if (!enrollment) {
      return res.status(403).json({ error: 'You must be enrolled in this course to access videos' });
    }
    
    // If course is paid and user hasn't paid, deny access
    if (video.course.price > 0 && !enrollment.isPaid) {
      return res.status(403).json({ 
        error: 'Payment required to access this content',
        courseId: video.course.id,
        price: video.course.price
      });
    }
    
    // All checks passed
    next();
  } catch (error) {
    console.error('Error checking video access:', error);
    res.status(500).json({ error: 'An error occurred while checking access permissions' });
  }
};

module.exports = {
  checkCourseAccess,
  checkVideoAccess
}; 