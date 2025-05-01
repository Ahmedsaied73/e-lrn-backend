const express = require('express');
const { 
  markVideoCompleted, 
  checkVideoCompletion, 
  getCourseVideoProgress 
} = require('../controllers/videoProgressController');
const { authenticateToken } = require('../middlewares');

const router = express.Router();

// Mark a video as completed
router.post('/complete', authenticateToken, markVideoCompleted);

// Check if a video has been completed
router.get('/:videoId', authenticateToken, checkVideoCompletion);

// Get all completed videos for a course
router.get('/course/:courseId', authenticateToken, getCourseVideoProgress);

module.exports = router;