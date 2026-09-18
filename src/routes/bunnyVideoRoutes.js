'use strict';

/**
 * Bunny Stream Video Routes
 *
 * Route → Middleware (auth/authz) → Controller → Service → DB/Bunny
 *
 * Mounted in app.js as:
 *   app.use('/courses', bunnyVideoRoutes)  → POST /courses/:courseSlug/videos
 *   app.use('/videos', bunnyVideoRoutes)   → POST /videos/:videoSlug/upload
 *                                          → GET  /videos/:videoSlug/playback
 *
 * All resource identifiers are public slugs. Numeric ids stay internal-only.
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
  reorderCourseVideos,
} = require('../controllers/bunnyVideoController');

// ─── Course-scoped video management ───────────────────────────────────────────

/**
 * POST /courses/:courseSlug/videos
 * Create a Bunny video record and Bunny video object.
 * Body: { "title": "Lecture 1 - Introduction" }
 * Auth: ADMIN only
 */
router.post('/:courseSlug/videos', authenticateToken, authorizeAdmin(), createBunnyVideo);

/**
 * GET /courses/:courseSlug/bunny-videos
 * List all Bunny videos for a course.
 * Auth: authenticateToken (Admin sees all; students see READY metadata)
 * Playback access remains protected by GET /videos/:videoSlug/playback.
 */
router.get('/:courseSlug/bunny-videos', authenticateToken, listCourseBunnyVideos);

/**
 * PUT /courses/:courseSlug/reorder
 * Reorder Bunny videos within a course.
 * Body: { "videoSlugs": ["abcdef123456", "ghijkl789abc"] } — BunnyVideo slugs in desired order
 * Auth: ADMIN only
 */
router.put('/:courseSlug/reorder', authenticateToken, authorizeAdmin(), reorderCourseVideos);

// ─── Video-level operations ────────────────────────────────────────────────────

/**
 * POST /videos/:videoSlug/upload
 * Stream a video binary to Bunny (multipart/form-data, field name: "video").
 * Auth: ADMIN only
 * Note: busboy streaming is handled inside the controller — no body-parser middleware here.
 *       Do NOT add express.json() or multer to this route.
 */
router.post('/:videoSlug/upload', authenticateToken, authorizeAdmin(), uploadBunnyVideo);

/**
 * GET /videos/:videoSlug/playback
 * Get a signed Bunny embed URL for a READY video.
 * Auth: authenticateToken (ADMIN + enrolled STUDENT)
 * Note: Admin bypasses enrollment check in the controller.
 */
router.get('/:videoSlug/playback', authenticateToken, ensureBunnySequentialAccess, getBunnyVideoPlayback);

/**
 * DELETE /videos/bunny/:videoSlug
 * Delete a Bunny video from Bunny Stream and local DB.
 * Auth: ADMIN only
 */
router.delete('/bunny/:videoSlug', authenticateToken, authorizeAdmin(), deleteBunnyVideo);

module.exports = router;