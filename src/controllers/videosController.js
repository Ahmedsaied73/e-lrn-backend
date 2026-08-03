const prisma = require('../config/db');
const fs = require('fs');
const path = require('path');

// Get all videos for a course
const getVideosByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    
    const videos = await prisma.video.findMany({
      where: {
        courseId: parseInt(courseId)
      }
    });

    // Add full URLs for thumbnails and video files
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const videosWithUrls = videos.map(video => ({
      ...video,
      url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
      thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail
    }));

    res.json(videosWithUrls);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
};

// Get a specific video
const getVideoById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const video = await prisma.video.findUnique({
      where: {
        id: parseInt(id)
      }
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Add full URLs for thumbnail and video file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    video.url = video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url;
    video.thumbnail = video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail;

    res.json(video);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
};

// Upload a new video
const uploadVideo = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { title, duration } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({ error: 'Video title is required' });
    }
    
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    // Ensure the course exists
    const course = await prisma.course.findUnique({
      where: {
        id: parseInt(courseId)
      }
    });

    if (!course) {
      // Delete uploaded files if course doesn't exist
      if (req.files.video && fs.existsSync(req.files.video[0].path)) {
        fs.unlinkSync(req.files.video[0].path);
      }
      if (req.files.thumbnail && fs.existsSync(req.files.thumbnail[0].path)) {
        fs.unlinkSync(req.files.thumbnail[0].path);
      }
      return res.status(404).json({ error: 'Course not found' });
    }

    // Set file paths
    const videoPath = `uploads/videos/${req.files.video[0].filename}`;
    let thumbnailPath = req.files.thumbnail 
      ? `uploads/videos/${req.files.thumbnail[0].filename}` 
      : 'uploads/videos/default-video-thumb.jpg';

    // Create the video record
    const video = await prisma.video.create({
      data: {
        title,
        url: videoPath,
        thumbnail: thumbnailPath,
        duration: duration ? parseInt(duration) : 0,
        courseId: parseInt(courseId)
      }
    });

    // Add full URLs for thumbnail and video file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    video.url = `${baseUrl}/${video.url}`;
    video.thumbnail = `${baseUrl}/${video.thumbnail}`;

    res.status(201).json({ message: 'Video uploaded successfully', video });
  } catch (error) {
    console.error('Error uploading video:', error);
    
    // Cleanup uploaded files in case of error
    if (req.files) {
      if (req.files.video && req.files.video[0] && fs.existsSync(req.files.video[0].path)) {
        fs.unlinkSync(req.files.video[0].path);
      }
      if (req.files.thumbnail && req.files.thumbnail[0] && fs.existsSync(req.files.thumbnail[0].path)) {
        fs.unlinkSync(req.files.thumbnail[0].path);
      }
    }
    
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

// Update a video
const updateVideo = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, duration } = req.body;

    // Check if video exists
    const existingVideo = await prisma.video.findUnique({
      where: { id: parseInt(id) }
    });

    if (!existingVideo) {
      // Delete uploaded files if video doesn't exist
      if (req.files) {
        if (req.files.video && req.files.video[0] && fs.existsSync(req.files.video[0].path)) {
          fs.unlinkSync(req.files.video[0].path);
        }
        if (req.files.thumbnail && req.files.thumbnail[0] && fs.existsSync(req.files.thumbnail[0].path)) {
          fs.unlinkSync(req.files.thumbnail[0].path);
        }
      }
      return res.status(404).json({ error: 'Video not found' });
    }

    // Prepare update data
    const updateData = {
      title: title || undefined,
      duration: duration ? parseInt(duration) : undefined
    };

    // Handle video file update
    if (req.files && req.files.video) {
      // Delete old video if it exists
      if (existingVideo.url && existingVideo.url.startsWith('uploads/')) {
        const oldVideoPath = path.join(__dirname, '../../', existingVideo.url);
        if (fs.existsSync(oldVideoPath)) {
          fs.unlinkSync(oldVideoPath);
        }
      }
      
      // Set new video path
      updateData.url = `uploads/videos/${req.files.video[0].filename}`;
    }

    // Handle thumbnail update
    if (req.files && req.files.thumbnail) {
      // Delete old thumbnail if it exists and is not the default
      if (existingVideo.thumbnail && 
          !existingVideo.thumbnail.includes('default-video-thumb.jpg') &&
          existingVideo.thumbnail.startsWith('uploads/')) {
        const oldThumbPath = path.join(__dirname, '../../', existingVideo.thumbnail);
        if (fs.existsSync(oldThumbPath)) {
          fs.unlinkSync(oldThumbPath);
        }
      }
      
      // Set new thumbnail path
      updateData.thumbnail = `uploads/videos/${req.files.thumbnail[0].filename}`;
    }

    // Update the video
    const updatedVideo = await prisma.video.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    // Add full URLs for thumbnail and video file
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    updatedVideo.url = updatedVideo.url && !updatedVideo.url.startsWith('http') ? `${baseUrl}/${updatedVideo.url}` : updatedVideo.url;
    updatedVideo.thumbnail = updatedVideo.thumbnail && !updatedVideo.thumbnail.startsWith('http') ? `${baseUrl}/${updatedVideo.thumbnail}` : updatedVideo.thumbnail;

    res.json({ message: 'Video updated successfully', video: updatedVideo });
  } catch (error) {
    console.error('Error updating video:', error);
    
    // Cleanup uploaded files in case of error
    if (req.files) {
      if (req.files.video && req.files.video[0] && fs.existsSync(req.files.video[0].path)) {
        fs.unlinkSync(req.files.video[0].path);
      }
      if (req.files.thumbnail && req.files.thumbnail[0] && fs.existsSync(req.files.thumbnail[0].path)) {
        fs.unlinkSync(req.files.thumbnail[0].path);
      }
    }
    
    res.status(500).json({ error: 'Failed to update video' });
  }
};

// Delete a video
const deleteVideo = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if video exists
    const existingVideo = await prisma.video.findUnique({
      where: { id: parseInt(id) }
    });

    if (!existingVideo) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Delete the video file if it exists
    if (existingVideo.url && existingVideo.url.startsWith('uploads/')) {
      const videoPath = path.join(__dirname, '../../', existingVideo.url);
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
    }

    // Delete the thumbnail if it exists and is not the default
    if (existingVideo.thumbnail && 
        !existingVideo.thumbnail.includes('default-video-thumb.jpg') &&
        existingVideo.thumbnail.startsWith('uploads/')) {
      const thumbnailPath = path.join(__dirname, '../../', existingVideo.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    // Delete the video record
    await prisma.video.delete({
      where: { id: parseInt(id) }
    });

    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
};

module.exports = {
  getVideosByCourse,
  getVideoById,
  uploadVideo,
  updateVideo,
  deleteVideo
}; 