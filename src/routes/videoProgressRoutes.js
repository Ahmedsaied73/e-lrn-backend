const express = require('express');
const { 
  markVideoCompleted, 
  checkVideoCompletion, 
  getCourseVideoProgress 
} = require('../controllers/videoProgressController');
const { authenticateToken } = require('../middlewares/index');

const router = express.Router();

// Mark a video as completed (body: { videoSlug })
router.post('/complete', authenticateToken, markVideoCompleted);

// Get all completed videos for a course (must come before /:videoSlug wildcard)
router.get('/course/:courseSlug', authenticateToken, getCourseVideoProgress);

// Check if a video has been completed
router.get('/:videoSlug', authenticateToken, checkVideoCompletion);

module.exports = router;
