const express = require('express');
const path = require('path');
const { 
  getVideosByCourse, 
  getVideoById, 
  uploadVideo, 
  updateVideo, 
  deleteVideo 
} = require('../controllers/videosController');
const { authenticateToken, authorizeAdmin } = require('../middlewares');
const { handleVideoUpload } = require('../utils/fileUpload');

const router = express.Router();

// Serve uploaded videos statically
router.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Get all videos for a course
router.get('/course/:courseId', authenticateToken, getVideosByCourse);

// Get a specific video
router.get('/:id', authenticateToken, getVideoById);

// Upload a new video to a course (admin only)
router.post('/course/:courseId', authenticateToken, authorizeAdmin(), handleVideoUpload, uploadVideo);

// Update a video (admin only)
router.put('/:id', authenticateToken, authorizeAdmin, handleVideoUpload, updateVideo);

// Delete a video (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, deleteVideo);

module.exports = router;