const prisma = require('@prisma/client');
const { PrismaClient } = prisma;
const prismaClient = new PrismaClient();

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
        courseId: requestedVideo.courseId,
        isPaid: true
      }
    });

    if (!enrollment) {
      return res.status(403).json({ 
        message: 'You must be enrolled in this course to access this video'
      });
    }

    // Get all videos in the course ordered by position/order
    const courseVideos = await prismaClient.video.findMany({
      where: { courseId: requestedVideo.courseId },
      orderBy: { position: 'asc' }
    });

    // Find the index of the requested video
    const currentVideoIndex = courseVideos.findIndex(video => video.id === parseInt(videoId));
    
    // If this is the first video or user is trying to access a previous video, allow access
    if (currentVideoIndex <= 0) {
      return next();
    }

    // Get the previous video
    const previousVideo = courseVideos[currentVideoIndex - 1];

    // Check if user has completed the previous video
    const previousVideoProgress = await prismaClient.videoProgress.findFirst({
      where: {
        userId: userId,
        videoId: previousVideo.id,
        completed: true
      }
    });

    if (!previousVideoProgress) {
      return res.status(403).json({ 
        message: 'You must complete the previous video before accessing this one',
        previousVideoId: previousVideo.id
      });
    }

    // Check if the previous video has an associated quiz
    const previousVideoQuiz = await prismaClient.quiz.findFirst({
      where: {
        videoId: previousVideo.id
      }
    });

    // If there's a quiz for the previous video, check if user has passed it
    if (previousVideoQuiz) {
      // Get all questions for the quiz to calculate total points
      const quizQuestions = await prismaClient.question.findMany({
        where: { quizId: previousVideoQuiz.id }
      });
      
      // Get user's answers for this quiz
      const userAnswers = await prismaClient.answer.findMany({
        where: {
          userId: userId,
          question: {
            quizId: previousVideoQuiz.id
          }
        },
        include: {
          question: true
        }
      });

      // If user hasn't attempted the quiz at all
      if (userAnswers.length === 0) {
        return res.status(403).json({ 
          message: 'You must complete the quiz for the previous video before proceeding',
          quizId: previousVideoQuiz.id,
          videoId: previousVideo.id
        });
      }

      // Calculate user's score
      let earnedPoints = 0;
      let totalPoints = 0;
      
      quizQuestions.forEach(question => {
        totalPoints += question.points;
      });
      
      userAnswers.forEach(answer => {
        if (answer.isCorrect) {
          earnedPoints += answer.question.points;
        }
      });
      
      const score = (earnedPoints / totalPoints) * 100;
      
      // Check if user passed the quiz
      if (score < previousVideoQuiz.passingScore) {
        return res.status(403).json({ 
          message: 'You must pass the quiz for the previous video before proceeding',
          quizId: previousVideoQuiz.id,
          videoId: previousVideo.id,
          yourScore: score,
          requiredScore: previousVideoQuiz.passingScore
        });
      }
    }
    
    // Check if the previous video has an associated assignment
    const previousVideoAssignment = await prismaClient.assignment.findFirst({
      where: {
        videoId: previousVideo.id
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
          videoId: previousVideo.id
        });
      }
      
      // If the assignment requires grading and hasn't been graded yet, don't allow proceeding
      if (userSubmission.status === 'PENDING') {
        return res.status(403).json({ 
          message: 'Your assignment submission is still pending review. Please wait for it to be graded before proceeding.',
          assignmentId: previousVideoAssignment.id,
          videoId: previousVideo.id,
          submissionId: userSubmission.id
        });
      }
      
      // If the assignment was rejected, don't allow proceeding
      if (userSubmission.status === 'REJECTED') {
        return res.status(403).json({ 
          message: 'Your assignment submission was rejected. Please review the feedback and resubmit.',
          assignmentId: previousVideoAssignment.id,
          videoId: previousVideo.id,
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