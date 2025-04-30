const prisma = require('../config/db');
const { getPlaylistDetails, getPlaylistVideos, getYoutubeStreamUrl } = require('../utils/youtubeApi');

/**
 * Import a YouTube playlist as a course
 */
const importYoutubePlaylist = async (req, res) => {
  try {
    const { playlistId, price = 0, grade } = req.body;
    
    if (!playlistId) {
      return res.status(400).json({ error: 'YouTube playlist ID is required' });
    }

    if (!grade) {
      return res.status(400).json({ error: 'Grade is required (FIRST_SECONDARY, SECOND_SECONDARY, or THIRD_SECONDARY)' });
    }

    // Validate grade is one of the allowed values
    const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (!validGrades.includes(grade)) {
      return res.status(400).json({ 
        error: 'Invalid grade value', 
        validValues: validGrades 
      });
    }

    // Check if the playlist already exists in the database
    const existingCourse = await prisma.course.findFirst({
      where: {
        youtubePlaylistId: playlistId
      }
    });

    if (existingCourse) {
      return res.status(409).json({ 
        error: 'This YouTube playlist has already been imported',
        courseId: existingCourse.id
      });
    }

    // Find the admin user
    const admin = await prisma.user.findFirst({
      where: {
        role: 'ADMIN'
      }
    });

    if (!admin) {
      return res.status(500).json({ error: 'Administrator account not found' });
    }

    // Fetch playlist details from YouTube API
    const playlistDetails = await getPlaylistDetails(playlistId);
    
    // Create the course
    const course = await prisma.course.create({
      data: {
        title: playlistDetails.title,
        description: playlistDetails.description,
        price: parseFloat(price),
        thumbnail: playlistDetails.thumbnail,
        isYoutube: true,
        youtubePlaylistId: playlistId,
        grade,
        teacherId: admin.id
      }
    });

    // Fetch videos from the playlist
    const videos = await getPlaylistVideos(playlistId);

    // Create video records for all videos in the playlist
    const videoPromises = videos.map(video => {
      return prisma.video.create({
        data: {
          title: video.title,
          url: getYoutubeStreamUrl(video.youtubeId),
          thumbnail: video.thumbnail,
          duration: video.duration,
          isYoutube: true,
          youtubeId: video.youtubeId,
          position: video.position,
          courseId: course.id
        }
      });
    });

    await Promise.all(videoPromises);

    // Return the created course with its videos
    const courseWithVideos = await prisma.course.findUnique({
      where: { id: course.id },
      include: {
        videos: {
          orderBy: {
            position: 'asc'
          }
        },
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    // Add the full URLs
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    courseWithVideos.thumbnail = courseWithVideos.thumbnail.startsWith('http') 
      ? courseWithVideos.thumbnail 
      : `${baseUrl}/${courseWithVideos.thumbnail}`;

    res.status(201).json({
      message: 'YouTube playlist imported successfully',
      course: courseWithVideos
    });
  } catch (error) {
    console.error('Error importing YouTube playlist:', error);
    
    // Create user-friendly error messages based on the error type
    let statusCode = 500;
    let errorMessage = 'Failed to import YouTube playlist';
    let errorDetails = error.message;
    
    // Handle specific error types with appropriate status codes
    if (error.message.includes('API key')) {
      statusCode = 401;  // Unauthorized - API key issues
      errorMessage = 'YouTube API key configuration error';
    } else if (error.message.includes('Playlist not found')) {
      statusCode = 404;  // Not Found - Playlist doesn't exist or isn't accessible
      errorMessage = 'Playlist not found or not accessible';
    } else if (error.response && error.response.status === 403) {
      statusCode = 403;  // Forbidden - API quota exceeded or access denied
      errorMessage = 'YouTube API access denied or quota exceeded';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage, 
      details: errorDetails 
    });
  }
};

/**
 * Sync a course with its YouTube playlist
 */
const syncYoutubeCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { grade } = req.body;
    
    // Find the course
    const course = await prisma.course.findUnique({
      where: { id: parseInt(id) },
      include: {
        videos: true
      }
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    if (!course.isYoutube || !course.youtubePlaylistId) {
      return res.status(400).json({ error: 'This is not a YouTube course' });
    }

    // Validate grade if provided
    if (grade) {
      const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
      if (!validGrades.includes(grade)) {
        return res.status(400).json({ 
          error: 'Invalid grade value', 
          validValues: validGrades 
        });
      }
    }

    // Fetch playlist details from YouTube API
    const playlistDetails = await getPlaylistDetails(course.youtubePlaylistId);
    
    // Update course details
    await prisma.course.update({
      where: { id: parseInt(id) },
      data: {
        title: playlistDetails.title,
        description: playlistDetails.description,
        thumbnail: playlistDetails.thumbnail,
        ...(grade && { grade }), // Only update grade if provided
      }
    });

    // Fetch videos from the playlist
    const youtubeVideos = await getPlaylistVideos(course.youtubePlaylistId);
    
    // Get existing video IDs
    const existingVideoIds = course.videos.map(v => v.youtubeId);
    
    // Find videos to add (new ones) and update (existing ones)
    const videosToAdd = youtubeVideos.filter(v => !existingVideoIds.includes(v.youtubeId));
    const videosToUpdate = youtubeVideos.filter(v => existingVideoIds.includes(v.youtubeId));
    
    // Create new video records
    const addPromises = videosToAdd.map(video => {
      return prisma.video.create({
        data: {
          title: video.title,
          url: getYoutubeStreamUrl(video.youtubeId),
          thumbnail: video.thumbnail,
          duration: video.duration,
          isYoutube: true,
          youtubeId: video.youtubeId,
          position: video.position,
          courseId: course.id
        }
      });
    });

    // Update existing video records
    const updatePromises = videosToUpdate.map(video => {
      const existingVideo = course.videos.find(v => v.youtubeId === video.youtubeId);
      return prisma.video.update({
        where: { id: existingVideo.id },
        data: {
          title: video.title,
          url: getYoutubeStreamUrl(video.youtubeId),
          thumbnail: video.thumbnail,
          duration: video.duration,
          position: video.position
        }
      });
    });

    // Execute all updates
    await Promise.all([...addPromises, ...updatePromises]);

    // Get the updated course with videos
    const updatedCourse = await prisma.course.findUnique({
      where: { id: parseInt(id) },
      include: {
        videos: {
          orderBy: {
            position: 'asc'
          }
        },
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    // Add the full URLs
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    updatedCourse.thumbnail = updatedCourse.thumbnail.startsWith('http') 
      ? updatedCourse.thumbnail 
      : `${baseUrl}/${updatedCourse.thumbnail}`;

    res.json({
      message: 'YouTube course synchronized successfully',
      course: updatedCourse,
      stats: {
        added: videosToAdd.length,
        updated: videosToUpdate.length
      }
    });
  } catch (error) {
    console.error('Error syncing YouTube course:', error);
    
    // Create user-friendly error messages based on the error type
    let statusCode = 500;
    let errorMessage = 'Failed to sync YouTube course';
    let errorDetails = error.message;
    
    // Handle specific error types with appropriate status codes
    if (error.message.includes('API key')) {
      statusCode = 401;  // Unauthorized - API key issues
      errorMessage = 'YouTube API key configuration error';
    } else if (error.message.includes('Playlist not found')) {
      statusCode = 404;  // Not Found - Playlist doesn't exist or isn't accessible
      errorMessage = 'Playlist not found or not accessible';
    } else if (error.response && error.response.status === 403) {
      statusCode = 403;  // Forbidden - API quota exceeded or access denied
      errorMessage = 'YouTube API access denied or quota exceeded';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage, 
      details: errorDetails 
    });
  }
};

module.exports = {
  importYoutubePlaylist,
  syncYoutubeCourse
};