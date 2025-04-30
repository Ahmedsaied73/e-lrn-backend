const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares');
const { importYoutubePlaylist, syncYoutubeCourse } = require('../controllers/youtubeController');

// Import a YouTube playlist as a course (admin only)
router.post('/import', authenticateToken, authorizeAdmin(['ADMIN']), importYoutubePlaylist);

// Sync a YouTube course with the latest playlist data (admin only)
router.post('/sync/:id', authenticateToken, authorizeAdmin(['ADMIN']), syncYoutubeCourse);

module.exports = router; 