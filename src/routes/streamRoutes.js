const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares');
const { checkCourseAccess, checkVideoAccess } = require('../middlewares/accessControl');
const videoStreamController = require('../controllers/videoStreamController');

// Video streaming URL
router.get(
  '/video/:videoId/url', 
  authenticateToken,
  checkVideoAccess,
  (req, res) => videoStreamController.getVideoStreamUrl(req, res)
);

// Video embed code
router.get(
  '/video/:videoId/embed', 
  authenticateToken,
  checkVideoAccess,
  (req, res) => videoStreamController.getVideoEmbedCode(req, res)
);

// Course player with all videos
router.get(
  '/course/:courseId/player', 
  authenticateToken,
  checkCourseAccess,
  (req, res) => videoStreamController.getCoursePlayer(req, res)
);

module.exports = router; 