const prisma = require('../config/db');

/**
 * Mark a video as completed for the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const markVideoCompleted = async (req, res) => {
  try {
    const { videoId } = req.body;
    const userId = req.user.id;

    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    // Verify the video exists
    const video = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      include: { course: true }
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Verify user is enrolled in the course
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        userId: userId,
        courseId: video.courseId,
        isPaid: true // Only paid enrollments can mark progress
      }
    });

    // Allow admins to bypass enrollment check
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });

    const isAdmin = user && user.role === 'ADMIN';

    if (!enrollment && !isAdmin) {
      return res.status(403).json({ 
        error: 'You must be enrolled in this course to mark progress' 
      });
    }

    // Create or update the video progress record
    const videoProgress = await prisma.videoProgress.upsert({
      where: {
        userId_videoId: {
          userId: userId,
          videoId: parseInt(videoId)
        }
      },
      update: {
        completed: true,
        updatedAt: new Date()
      },
      create: {
        userId: userId,
        videoId: parseInt(videoId),
        completed: true
      }
    });

    // Update the course progress if this is a student
    if (enrollment) {
      // Count total videos in the course
      const totalVideos = await prisma.video.count({
        where: { courseId: video.courseId }
      });

      // Count completed videos for this user in this course
      const completedVideos = await prisma.videoProgress.count({
        where: {
          userId: userId,
          video: {
            courseId: video.courseId
          },
          completed: true
        }
      });

      // Calculate progress percentage
      const progressPercentage = (completedVideos / totalVideos) * 100;

      // Update enrollment progress
      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          progress: progressPercentage,
          lastAccess: new Date(),
          // If all videos are completed, mark the course as completed
          ...(completedVideos === totalVideos ? {
            isCompleted: true,
            completedAt: new Date()
          } : {})
        }
      });
    }

    res.json({
      message: 'Video marked as completed',
      videoProgress
    });
  } catch (error) {
    console.error('Error marking video as completed:', error);
    res.status(500).json({ error: 'Failed to mark video as completed' });
  }
};

/**
 * Check if a video has been completed by the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const checkVideoCompletion = async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.user.id;

    // Find the video progress record
    const videoProgress = await prisma.videoProgress.findUnique({
      where: {
        userId_videoId: {
          userId: userId,
          videoId: parseInt(videoId)
        }
      }
    });

    // Return completion status
    res.json({
      videoId: parseInt(videoId),
      completed: videoProgress ? videoProgress.completed : false,
      watchedAt: videoProgress ? videoProgress.watchedAt : null
    });
  } catch (error) {
    console.error('Error checking video completion:', error);
    res.status(500).json({ error: 'Failed to check video completion status' });
  }
};

/**
 * Get all completed videos for a course by the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const getCourseVideoProgress = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user.id;

    // Verify the course exists
    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) },
      include: { videos: true }
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Get all video IDs for this course
    const videoIds = course.videos.map(video => video.id);

    // Get progress for all videos in this course
    const videoProgress = await prisma.videoProgress.findMany({
      where: {
        userId: userId,
        videoId: { in: videoIds }
      }
    });

    // Create a map of video ID to completion status
    const progressMap = {};
    videoProgress.forEach(progress => {
      progressMap[progress.videoId] = {
        completed: progress.completed,
        watchedAt: progress.watchedAt
      };
    });

    // Create the response with all videos and their completion status
    const videosWithProgress = course.videos.map(video => ({
      id: video.id,
      title: video.title,
      duration: video.duration,
      completed: progressMap[video.id] ? progressMap[video.id].completed : false,
      watchedAt: progressMap[video.id] ? progressMap[video.id].watchedAt : null
    }));

    res.json({
      courseId: parseInt(courseId),
      totalVideos: course.videos.length,
      completedVideos: Object.values(progressMap).filter(p => p.completed).length,
      videos: videosWithProgress
    });
  } catch (error) {
    console.error('Error getting course video progress:', error);
    res.status(500).json({ error: 'Failed to get course video progress' });
  }
};

module.exports = {
  markVideoCompleted,
  checkVideoCompletion,
  getCourseVideoProgress
};