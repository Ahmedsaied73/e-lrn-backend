const prisma = require('../config/db');
const { 
  getYoutubeStreamUrl, 
  getHLSStreamInfo 
} = require('../utils/youtubeApi');
const { 
  generatePlayerHTML, 
  generatePlayerScript 
} = require('../utils/youtubePlayerUtils');

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
    
    // Note: Access check is now handled by middleware
    
    // Set options based on query parameters
    const options = {
      autoplay: autoplay === '1' ? 1 : 0,
      controls: controls === '0' ? 0 : 1,
      playbackQuality: quality || 'default'
    };
    
    // Prepare response based on video type
    let response;
    
    if (video.isYoutube) {
      // Get stream URL for YouTube video
      const youtubeUrl = getYoutubeStreamUrl(video.youtubeId, options);
      
      response = {
        videoId: parseInt(videoId),
        title: video.title,
        isYoutube: true,
        youtubeId: video.youtubeId,
        streamUrl: youtubeUrl,
        embedHtml: `<iframe width="640" height="360" src="${youtubeUrl}" frameborder="0" allowfullscreen></iframe>`,
        options
      };
    } else {
      // Regular video file
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const streamUrl = video.url.startsWith('http') ? video.url : `${baseUrl}/${video.url}`;
      
      response = {
        videoId: parseInt(videoId),
        title: video.title,
        isYoutube: false,
        streamUrl,
        options
      };
    }
    
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
    
    // Note: Access check is now handled by middleware
    
    // Options for embedding
    const options = {
      width: parseInt(width),
      height: parseInt(height),
      autoplay: autoplay === '1' ? 1 : 0,
      controls: controls === '0' ? 0 : 1
    };
    
    // Prepare response based on video type
    let response;
    
    if (video.isYoutube) {
      // Get YouTube embed code
      const youtubeUrl = getYoutubeStreamUrl(video.youtubeId, options);
      const embedHtml = `<iframe width="${options.width}" height="${options.height}" src="${youtubeUrl}" frameborder="0" allowfullscreen></iframe>`;
      const playerScript = generatePlayerScript(video.youtubeId, options);
      
      response = {
        videoId: parseInt(videoId),
        title: video.title,
        isYoutube: true,
        youtubeId: video.youtubeId,
        embedHtml,
        playerScript,
        options
      };
    } else {
      // Regular video file
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const videoUrl = video.url.startsWith('http') ? video.url : `${baseUrl}/${video.url}`;
      const thumbnailUrl = video.thumbnail.startsWith('http') ? video.thumbnail : `${baseUrl}/${video.thumbnail}`;
      
      const embedHtml = `<video id="player-${videoId}" width="${options.width}" height="${options.height}" ${options.controls ? 'controls' : ''} ${options.autoplay ? 'autoplay' : ''} poster="${thumbnailUrl}"><source src="${videoUrl}" type="video/mp4"></video>`;
      
      response = {
        videoId: parseInt(videoId),
        title: video.title,
        isYoutube: false,
        embedHtml,
        options
      };
    }
    
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
    
    // Note: Access check is now handled by middleware
    
    // Prepare response based on course type
    if (course.isYoutube && course.videos.length > 0) {
      // Get first video for initial player
      const initialVideo = course.videos[0];
      
      // Generate HTML for the player
      const playerHtml = generatePlayerHTML(initialVideo.youtubeId, { width: 800, height: 450 });
      
      // Prepare playlist data
      const playlist = course.videos.map(video => ({
        id: video.id,
        title: video.title,
        youtubeId: video.youtubeId,
        thumbnail: video.thumbnail,
        duration: video.duration,
        position: video.position || 0
      }));
      
      // Generate playlist HTML and script
      const playlistHtml = `<div class="course-playlist"><!-- Playlist HTML --></div>`;
      const playerScript = generatePlayerScript(initialVideo.youtubeId, { playlist });
      
      res.json({
        courseId: parseInt(courseId),
        title: course.title,
        isYoutube: true,
        initialVideoId: initialVideo.id,
        embedHtml: playerHtml,
        playlistHtml,
        playerScript,
        playlist
      });
    } else {
      // Regular videos
      // (Implementation would be similar but for regular video files)
      res.status(501).json({ error: 'Regular video course player not implemented yet' });
    }
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
  getCoursePlayer
}; 