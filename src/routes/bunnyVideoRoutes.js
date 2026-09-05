'use strict';

/**
 * Bunny Stream Video Routes
 *
 * Route → Middleware (auth/authz) → Controller → Service → DB/Bunny
 *
 * Mounted in app.js as:
 *   app.use('/courses', bunnyVideoRoutes)  → POST /courses/:courseId/videos
 *   app.use('/videos', bunnyVideoRoutes)   → POST /videos/:videoId/upload
 *                                          → GET  /videos/:videoId/playback
 *
 * Conflict analysis vs existing routes:
 *   Existing /courses routes: GET /, GET /:id, POST /, PUT /:id, DELETE /:id (no /courses/:id/videos)
 *   Existing /videos routes: GET /course/:courseId, GET /:id, POST /course/:courseId, PUT /:id, DELETE /:id
 *   New routes below do NOT conflict with any of the above paths.
 *
 * Rate limiting note: the global limiter in app.js (100 req/15min) applies.
 * Upload endpoint has a longer effective timeout due to streaming — ensure
 * your Nginx/proxy upstream read timeout is set high enough for large files.
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { ensureBunnySequentialAccess } = require('../middlewares/bunnySequentialAccess');
const {
  createBunnyVideo,
  uploadBunnyVideo,
  getBunnyVideoPlayback,
  deleteBunnyVideo,
  listCourseBunnyVideos,
} = require('../controllers/bunnyVideoController');

// ─── Course-scoped video management ───────────────────────────────────────────

/**
 * POST /courses/:courseId/videos
 * Create a Bunny video record and Bunny video object.
 * Body: { "title": "Lecture 1 - Introduction" }
 * Auth: ADMIN only
 */
router.post('/:courseId/videos', authenticateToken, authorizeAdmin(), createBunnyVideo);

/**
 * GET /courses/:courseId/bunny-videos
 * List all Bunny videos for a course.
 * Auth: authenticateToken (Admin sees all; students see READY metadata)
 * Playback access remains protected by GET /videos/:videoId/playback.
 */
router.get('/:courseId/bunny-videos', authenticateToken, listCourseBunnyVideos);

// ─── Video-level operations ────────────────────────────────────────────────────

/**
 * POST /videos/:videoId/upload
 * Stream a video binary to Bunny (multipart/form-data, field name: "video").
 * Auth: ADMIN only
 * Note: busboy streaming is handled inside the controller — no body-parser middleware here.
 *       Do NOT add express.json() or multer to this route.
 */
router.post('/:videoId/upload', authenticateToken, authorizeAdmin(), uploadBunnyVideo);

/**
 * GET /videos/:videoId/playback
 * Get a signed Bunny embed URL for a READY video.
 * Auth: authenticateToken (ADMIN + enrolled STUDENT)
 * Note: Admin bypasses enrollment check in the controller.
 */
router.get('/:videoId/playback', authenticateToken, ensureBunnySequentialAccess, getBunnyVideoPlayback);

/**
 * DELETE /videos/bunny/:videoId
 * Delete a Bunny video from Bunny Stream and local DB.
 * Auth: ADMIN only
 */
router.delete('/bunny/:videoId', authenticateToken, authorizeAdmin(), deleteBunnyVideo);

module.exports = router;

