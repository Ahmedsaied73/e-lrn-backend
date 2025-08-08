const express = require('express');
const router = express.Router();
const muxController = require('../controllers/muxController');
const { isAdmin, authenticateToken } = require('../middlewares');

// Admin routes for video management
router.post('/uploads', authenticateToken, require('../middlewares').authorizeAdmin(['ADMIN']), muxController.createDirectUpload);
router.get('/videos/:videoId/asset', authenticateToken, require('../middlewares').authorizeAdmin(['ADMIN']), muxController.getAssetInfo);
router.delete('/videos/:videoId/asset', authenticateToken, require('../middlewares').authorizeAdmin(['ADMIN']), muxController.deleteAsset);

// User routes for video streaming (requires authentication)
router.get('/videos/:videoId/stream', authenticateToken, muxController.getStreamingUrl);

// Import mux config
const muxConfig = require('../config/muxConfig');

// Webhook endpoint (no auth required, verified by signature)
router.post(muxConfig.webhooks.path, express.json({ type: 'application/json' }), muxController.handleMuxWebhook);

module.exports = router;