const prisma = require('../config/db');

/**
 * Generate a streaming URL for a video
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getVideoStreamUrl = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality, autoplay, controls } = req.query;
    
    // Find video in database
    const video = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      include: {
        course: true
      }
    });
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Set options based on query parameters
    const options = {
      autoplay: autoplay === '1' ? 1 : 0,
      controls: controls === '0' ? 0 : 1,
      playbackQuality: quality || 'default'
    };
    
    // Regular video file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const streamUrl = video.url && video.url.startsWith('http') ? video.url : `${baseUrl}/${video.url || ''}`;
    
    const response = {
      videoId: parseInt(videoId),
      title: video.title,
      streamUrl,
      options
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error generating stream URL:', error);
    res.status(500).json({ error: 'Failed to generate stream URL' });
  }
};

/**
 * Generate embed code for a video
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getVideoEmbedCode = async (req, res) => {
  try {
    const { videoId } = req.params;
    const { width = 640, height = 360, autoplay = 0, controls = 1 } = req.query;
    
    // Find video in database
    const video = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      include: {
        course: true
      }
    });
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Options for embedding
    const options = {
      width: parseInt(width),
      height: parseInt(height),
      autoplay: autoplay === '1' ? 1 : 0,
      controls: controls === '0' ? 0 : 1
    };
    
    // Regular video file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const videoUrl = video.url && video.url.startsWith('http') ? video.url : `${baseUrl}/${video.url || ''}`;
    const thumbnailUrl = video.thumbnail && video.thumbnail.startsWith('http') ? video.thumbnail : `${baseUrl}/${video.thumbnail || ''}`;
    
    const embedHtml = `<video id="player-${videoId}" width="${options.width}" height="${options.height}" ${options.controls ? 'controls' : ''} ${options.autoplay ? 'autoplay' : ''} poster="${thumbnailUrl}"><source src="${videoUrl}" type="video/mp4"></video>`;
    
    const response = {
      videoId: parseInt(videoId),
      title: video.title,
      embedHtml,
      options
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error generating embed code:', error);
    res.status(500).json({ error: 'Failed to generate embed code' });
  }
};

/**
 * Get course player with all videos
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getCoursePlayer = async (req, res) => {
  try {
    const { courseId } = req.params;
    
    // Find course with its videos
    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) },
      include: {
        videos: {
          orderBy: {
            position: 'asc'
          }
        }
      }
    });
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    
    res.json({
      courseId: parseInt(courseId),
      title: course.title,
      videos: course.videos
    });
  } catch (error) {
    console.error('Error generating course player:', error);
    res.status(500).json({ error: 'Failed to generate course player' });
  }
};

/**
 * Format duration in seconds to human readable format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (HH:MM:SS)
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

module.exports = {
  getVideoStreamUrl,
  getVideoEmbedCode,
  getCoursePlayer,
  formatDuration
};