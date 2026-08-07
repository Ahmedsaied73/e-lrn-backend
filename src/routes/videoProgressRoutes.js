const express = require('express');
const { 
  markVideoCompleted, 
  checkVideoCompletion, 
  getCourseVideoProgress 
} = require('../controllers/videoProgressController');
const { authenticateToken } = require('../middlewares/index');

const router = express.Router();

// Mark a video as completed
router.post('/complete', authenticateToken, markVideoCompleted);

// Get all completed videos for a course (must come before /:videoId wildcard)
router.get('/course/:courseId', authenticateToken, getCourseVideoProgress);

// Check if a video has been completed
router.get('/:videoId', authenticateToken, checkVideoCompletion);

module.exports = router;
