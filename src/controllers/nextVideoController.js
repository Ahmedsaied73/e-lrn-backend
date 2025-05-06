const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Get the next video in a course sequence
 * This controller finds the next video after the current one
 * and checks if the user has completed prerequisites
 */
const getNextVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.user.id;
    
    // Get the current video with its course information
    const currentVideo = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      include: {
        course: true
      }
    });

    if (!currentVideo) {
      return res.status(404).json({ message: 'Video not found' });
    }

    // Get all videos in the course ordered by position/order
    const courseVideos = await prisma.video.findMany({
      where: { courseId: currentVideo.courseId },
      orderBy: { position: 'asc' }
    });

    // Find the index of the current video
    const currentVideoIndex = courseVideos.findIndex(video => video.id === parseInt(videoId));
    
    // Check if this is the last video
    if (currentVideoIndex === courseVideos.length - 1) {
      return res.status(200).json({ 
        message: 'This is the last video in the course',
        isLastVideo: true,
        courseId: currentVideo.courseId
      });
    }

    // Get the next video
    const nextVideo = courseVideos[currentVideoIndex + 1];

    // For non-admin users, check if they've completed the current video
    if (req.user.role !== 'ADMIN') {
      // Check if user has completed the current video
      const currentVideoProgress = await prisma.videoProgress.findFirst({
        where: {
          userId: userId,
          videoId: parseInt(videoId),
          completed: true
        }
      });

      if (!currentVideoProgress) {
        return res.status(403).json({ 
          message: 'You must complete the current video before accessing the next one',
          currentVideoId: parseInt(videoId)
        });
      }

      // Check if the current video has an associated quiz
      const currentVideoQuiz = await prisma.quiz.findFirst({
        where: {
          videoId: parseInt(videoId)
        }
      });

      // If there's a quiz for the current video, check if user has passed it
      if (currentVideoQuiz) {
        // Get all questions for the quiz to calculate total points
        const quizQuestions = await prisma.question.findMany({
          where: { quizId: currentVideoQuiz.id }
        });
        
        // Get user's answers for this quiz
        const userAnswers = await prisma.answer.findMany({
          where: {
            userId: userId,
            question: {
              quizId: currentVideoQuiz.id
            }
          },
          include: {
            question: true
          }
        });

        // If user hasn't attempted the quiz at all
        if (userAnswers.length === 0) {
          return res.status(403).json({ 
            message: 'You must complete the quiz for the current video before proceeding',
            quizId: currentVideoQuiz.id,
            videoId: parseInt(videoId)
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
        if (score < currentVideoQuiz.passingScore) {
          return res.status(403).json({ 
            message: 'You must pass the quiz for the current video before proceeding',
            quizId: currentVideoQuiz.id,
            videoId: parseInt(videoId),
            yourScore: score,
            requiredScore: currentVideoQuiz.passingScore
          });
        }
      }
    }

    // Return the next video information
    return res.status(200).json({
      message: 'Next video retrieved successfully',
      nextVideo: {
        id: nextVideo.id,
        title: nextVideo.title,
        description: nextVideo.description,
        duration: nextVideo.duration,
        position: nextVideo.position,
        thumbnailUrl: nextVideo.thumbnail
      }
    });
  } catch (error) {
    console.error('Error getting next video:', error);
    res.status(500).json({ message: 'Server error while getting next video' });
  }
};

module.exports = { getNextVideo };