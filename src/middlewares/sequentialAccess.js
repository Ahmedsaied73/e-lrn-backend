const prismaClient = require('../config/db');
const quizService = require('../services/quizService');

/**
 * Middleware to ensure sequential access to course content
 * Users must complete previous videos and quizzes before accessing the next video
 */
const ensureSequentialAccess = async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const userId = req.user.id;
    
    // Skip check for admin users - they can access any content
    if (req.user.role === 'ADMIN') {
      return next();
    }

    // Get the requested video with its course information
    const requestedVideo = await prismaClient.video.findUnique({
      where: { id: parseInt(videoId) },
      include: {
        course: true
      }
    });

    if (!requestedVideo) {
      return res.status(404).json({ message: 'Video not found' });
    }

    // Check if user is enrolled in the course
    const enrollment = await prismaClient.enrollment.findFirst({
      where: {
        userId: userId,
        courseId: requestedVideo.courseId
      }
    });

    if (!enrollment) {
      return res.status(403).json({ 
        message: 'You must be enrolled in this course to access this video'
      });
    }

    // Get all videos in the course ordered by position/order (with fallback to id)
    const courseVideos = await prismaClient.video.findMany({
      where: { courseId: requestedVideo.courseId },
      orderBy: [
        { position: 'asc' },
        { id: 'asc' }
      ]
    });

    // Find the index of the requested video
    const currentVideoIndex = courseVideos.findIndex(video => video.id === parseInt(videoId));
    
    // If this is the first video or user is trying to access a previous video, allow access
    if (currentVideoIndex <= 0) {
      return next();
    }

    // Check sequential gate: video completion + quiz pass (or gate exemption)
    const gate = await quizService.evaluateGate(userId, parseInt(videoId), req.user.role);
    if (!gate.allowed) {
      return res.status(403).json({
        message: gate.reason,
        previousVideoId: gate.previousVideoId,
        quizId: gate.quizId,
        yourScore: gate.bestScore,
        requiredScore: gate.required,
      });
    }

    // The previous video in this course's sequence (index is > 0 here)
    const previousVideoId = courseVideos[currentVideoIndex - 1].id;

    // Check if the previous video has an associated assignment
    const previousVideoAssignment = await prismaClient.assignment.findFirst({
      where: {
        videoId: previousVideoId
      }
    });

    // If there's an assignment for the previous video, check if user has submitted it
    if (previousVideoAssignment) {
      // Get user's submission for this assignment
      const userSubmission = await prismaClient.submission.findUnique({
        where: {
          userId_assignmentId: {
            userId: userId,
            assignmentId: previousVideoAssignment.id
          }
        }
      });

      // If user hasn't submitted the assignment at all
      if (!userSubmission) {
        return res.status(403).json({ 
          message: 'You must submit the assignment for the previous video before proceeding',
          assignmentId: previousVideoAssignment.id,
          videoId: previousVideoId
        });
      }
      
      // If the assignment requires grading and hasn't been graded yet, don't allow proceeding
      if (userSubmission.status === 'PENDING') {
        return res.status(403).json({ 
          message: 'Your assignment submission is still pending review. Please wait for it to be graded before proceeding.',
          assignmentId: previousVideoAssignment.id,
          videoId: previousVideoId,
          submissionId: userSubmission.id
        });
      }
      
      // If the assignment was rejected, don't allow proceeding
      if (userSubmission.status === 'REJECTED') {
        return res.status(403).json({ 
          message: 'Your assignment submission was rejected. Please review the feedback and resubmit.',
          assignmentId: previousVideoAssignment.id,
          videoId: previousVideoId,
          submissionId: userSubmission.id
        });
      }
    }

    // If all checks pass, allow access to the requested video
    next();
  } catch (error) {
    console.error('Sequential access check error:', error);
    res.status(500).json({ message: 'Server error while checking content access' });
  }
};

module.exports = { ensureSequentialAccess };