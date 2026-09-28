const prisma = require('../config/db');

// Get all videos for a course (with pagination)
const getVideosByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const take = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * take;
    
    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        where: { courseId: parseInt(courseId) },
        skip,
        take
      }),
      prisma.video.count({ where: { courseId: parseInt(courseId) } })
    ]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const videosWithUrls = videos.map(video => ({
      ...video,
      url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
      thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail
    }));

    res.json({
      success: true,
      data: videosWithUrls,
      meta: {
        total,
        page,
        limit: take,
        totalPages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
};

// Get a specific video
const getVideoById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const video = await prisma.video.findUnique({
      where: { id: parseInt(id) }
    });

    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    video.url = video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url;
    video.thumbnail = video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail;

    res.json({ success: true, data: video });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch video' });
  }
};

// Create a new video
const uploadVideo = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { title, duration, url, thumbnail } = req.body;

    if (!title || !url) {
      return res.status(400).json({ success: false, error: 'Video title and url are required' });
    }

    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) }
    });

    if (!course) {
      return res.status(404).json({ success: false, error: 'Course not found' });
    }

    const video = await prisma.video.create({
      data: {
        title,
        url,
        thumbnail: thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
        duration: duration ? parseInt(duration) : 0,
        courseId: parseInt(courseId)
      }
    });

    res.status(201).json({ success: true, message: 'Video added successfully', data: video });
  } catch (error) {
    console.error('Error adding video:', error);
    res.status(500).json({ success: false, error: 'Failed to add video' });
  }
};

// Update a video
const updateVideo = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, duration, url, thumbnail } = req.body;

    const existingVideo = await prisma.video.findUnique({
      where: { id: parseInt(id) }
    });

    if (!existingVideo) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    const updateData = {
      title: title || undefined,
      duration: duration !== undefined ? parseInt(duration) : undefined,
      url: url || undefined,
      thumbnail: thumbnail || undefined
    };

    const updatedVideo = await prisma.video.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    res.json({ success: true, message: 'Video updated successfully', data: updatedVideo });
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({ success: false, error: 'Failed to update video' });
  }
};

// Delete a video
const deleteVideo = async (req, res) => {
  try {
    const { id } = req.params;

    const existingVideo = await prisma.video.findUnique({
      where: { id: parseInt(id) }
    });

    if (!existingVideo) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    await prisma.video.delete({
      where: { id: parseInt(id) }
    });

    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ success: false, error: 'Failed to delete video' });
  }
};

module.exports = {
  getVideosByCourse,
  getVideoById,
  uploadVideo,
  updateVideo,
  deleteVideo
};