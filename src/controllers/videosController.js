const prisma = require('../config/db');
const fs = require('fs');
const path = require('path');
const { processVideo } = require('./videoProcessingController');

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
    const { title, duration, customPath } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({ error: 'Video title is required' });
    }

    // If customPath is provided, use it; otherwise, require a file upload
    let videoPath;
    if (customPath) {
      if (!fs.existsSync(customPath)) {
        return res.status(400).json({ error: 'Custom video path does not exist on server' });
      }
      videoPath = customPath;
    } else if (req.files && req.files.video) {
      videoPath = `uploads/videos/${req.files.video[0].filename}`;
    } else {
      return res.status(400).json({ error: 'Video file or custom path is required' });
    }

    let thumbnailPath = req.files && req.files.thumbnail
      ? `uploads/videos/${req.files.thumbnail[0].filename}`
      : 'uploads/videos/default-video-thumb.jpg';

    // Ensure the course exists
    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) }
    });

    if (!course) {
      // Clean up uploaded files if course doesn't exist
      if (req.files && req.files.video && fs.existsSync(req.files.video[0].path)) {
        fs.unlinkSync(req.files.video[0].path);
      }
      if (req.files && req.files.thumbnail && fs.existsSync(req.files.thumbnail[0].path)) {
        fs.unlinkSync(req.files.thumbnail[0].path);
      }
      return res.status(404).json({ error: 'Course not found' });
    }

    // Create the video record
    const video = await prisma.video.create({
      data: {
        title,
        url: videoPath, // Temporary path
        thumbnail: thumbnailPath,
        duration: duration ? parseInt(duration) : 0,
        courseId: parseInt(courseId)
      }
    });

    // Process the video to HLS format
    if (req.files && req.files.video) {
      const absoluteVideoPath = path.join(__dirname, '../../', videoPath);
      await processVideo(video.id, absoluteVideoPath);

      // Delete the original uploaded video file
      if (fs.existsSync(absoluteVideoPath)) {
        fs.unlinkSync(absoluteVideoPath);
      }

      // Update the video URL to the HLS playlist
      const hlsUrl = `uploads/videos/${video.id}/output.m3u8`;
      const updatedVideo = await prisma.video.update({
        where: { id: video.id },
        data: { url: hlsUrl }
      });

      // Add full URLs for thumbnail and video file if relative
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      updatedVideo.url = updatedVideo.url && !updatedVideo.url.startsWith('http') && !path.isAbsolute(updatedVideo.url) ? `${baseUrl}/${updatedVideo.url}` : updatedVideo.url;
      updatedVideo.thumbnail = updatedVideo.thumbnail && !updatedVideo.thumbnail.startsWith('http') ? `${baseUrl}/${updatedVideo.thumbnail}` : updatedVideo.thumbnail;

      res.status(201).json({ message: 'Video uploaded and processed successfully', video: updatedVideo });
    } else {
        // Add full URLs for thumbnail and video file if relative
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        video.url = video.url && !video.url.startsWith('http') && !path.isAbsolute(video.url) ? `${baseUrl}/${video.url}` : video.url;
        video.thumbnail = video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail;

        res.status(201).json({ message: 'Video uploaded successfully', video });
    }
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
      // Delete old video folder if it exists
      if (existingVideo.url && existingVideo.url.startsWith('uploads/')) {
        const oldVideoFolderPath = path.join(__dirname, '../../', `uploads/videos/${existingVideo.id}`);
        if (fs.existsSync(oldVideoFolderPath)) {
          fs.rmSync(oldVideoFolderPath, { recursive: true, force: true });
        }
      }
      
      // Delete the original uploaded video file if it exists
      if (req.files && req.files.video && existingVideo.url && !existingVideo.url.includes('output.m3u8')) {
        const oldOriginalVideoPath = path.join(__dirname, '../../', existingVideo.url);
        if (fs.existsSync(oldOriginalVideoPath)) {
          fs.unlinkSync(oldOriginalVideoPath);
        }
      }

      // Set new video path and process it
      const newVideoPath = `uploads/videos/${req.files.video[0].filename}`;
      const absoluteVideoPath = path.join(__dirname, '../../', newVideoPath);
      await processVideo(existingVideo.id, absoluteVideoPath);
      updateData.url = `uploads/videos/${existingVideo.id}/output.m3u8`;
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

    // Delete the video folder if it exists
    if (existingVideo.url && existingVideo.url.startsWith('uploads/')) {
      const videoFolderPath = path.join(__dirname, '../../', `uploads/videos/${existingVideo.id}`);
      if (fs.existsSync(videoFolderPath)) {
        fs.rmSync(videoFolderPath, { recursive: true, force: true });
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