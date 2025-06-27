const express = require('express');
const { uploadAndConvertVideo, getTemporaryStreamUrl, serveHlsPlaylist } = require('../controllers/videoProcessingController');
const { authenticateToken } = require('../middlewares');
const multer = require('multer');
const path = require('path');

const upload = multer({ dest: path.join('uploads', 'tmp') });
const router = express.Router();

// 7. Upload video and convert to HLS (user or admin)
router.post('/upload', authenticateToken, upload.single('video'), uploadAndConvertVideo);

// 8. Generate temporary streaming URL
router.get('/:id/stream-url', authenticateToken, getTemporaryStreamUrl);

// 8b. Serve HLS playlist (secured by JWT)
router.get('/stream/:id', serveHlsPlaylist);

module.exports = router;
