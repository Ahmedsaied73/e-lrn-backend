const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares');
const { checkCourseAccess, checkVideoAccess } = require('../middlewares/accessControl');
const { ensureSequentialAccess } = require('../middlewares/sequentialAccess');
const videoStreamController = require('../controllers/videoStreamController');
const nextVideoController = require('../controllers/nextVideoController');

// Video streaming URL
router.get(
  '/video/:videoId/url', 
  authenticateToken,
  checkVideoAccess,
  ensureSequentialAccess,
  (req, res) => videoStreamController.getVideoStreamUrl(req, res)
);

// Video embed code
router.get(
  '/video/:videoId/embed', 
  authenticateToken,
  checkVideoAccess,
  ensureSequentialAccess,
  (req, res) => videoStreamController.getVideoEmbedCode(req, res)
);

// Course player with all videos
router.get(
  '/course/:courseId/player', 
  authenticateToken,
  checkCourseAccess,
  (req, res) => videoStreamController.getCoursePlayer(req, res)
);

// Get next video in sequence
router.get(
  '/video/:videoId/next',
  authenticateToken,
  checkVideoAccess,
  (req, res) => nextVideoController.getNextVideo(req, res)
);

module.exports = router;