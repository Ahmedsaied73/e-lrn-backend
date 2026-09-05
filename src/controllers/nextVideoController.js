const prisma = require('../config/db');
const quizService = require('../services/quizService');

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

    // Evaluate sequential gate: completion of current video + quiz pass (or exemption)
    const gate = await quizService.evaluateGate(userId, nextVideo.id, req.user.role);
    if (!gate.allowed) {
      return res.status(403).json({
        message: gate.reason,
        currentVideoId: parseInt(videoId),
        quizId: gate.quizId,
        yourScore: gate.bestScore,
        requiredScore: gate.required,
      });
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