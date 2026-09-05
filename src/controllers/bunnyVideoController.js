'use strict';

/**
 * Bunny Video Controller
 *
 * Thin HTTP layer only — extract params, call service, map to response envelope.
 * No business logic here. No Bunny API calls here.
 *
 * Response envelope matches existing repo pattern:
 *   Success: { success: true, data: { ... } }
 *   Error: handled by global error handler via next(err)
 */

const busboy = require('busboy');
const bunnyVideoService = require('../services/bunnyVideoService');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');
const { AppError, ErrorCodes } = require('../utils/AppError');

// Allowed MIME types for video upload — server-side allowlist, not client-supplied
const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',    // .mov
  'video/x-matroska',  // .mkv
  'video/x-msvideo',   // .avi
  'video/webm',
]);

// Structured log helper — same pattern as service layer
const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

// ─── POST /courses/:courseId/videos ──────────────────────────────────────────

/**
 * Create a Bunny video record + Bunny video object.
 * Auth: authenticateToken + authorizeAdmin (admin only)
 *
 * Body: { title: string }
 */
const createBunnyVideo = async (req, res, next) => {
  try {
    const courseId = parseInt(req.params.courseId, 10);
    const { title } = req.body;

    if (!courseId || isNaN(courseId)) {
      return next(new AppError('Invalid course ID', 400, ErrorCodes.COURSE_NOT_FOUND));
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return next(new AppError('Video title is required', 400, 'VALIDATION_ERROR'));
    }

    const video = await bunnyVideoService.createVideo({
      courseId,
      title: title.trim(),
      requestedByUserId: req.user.id, // always from JWT — never trust body/params
    });

    return res.status(201).json({
      success: true,
      data: {
        id: video.id,
        courseId: video.courseId,
        title: video.title,
        bunnyVideoId: video.bunnyVideoId,
        status: video.status,
        createdAt: video.createdAt,
      },
    });
  } catch (err) {
    return next(err);
  }
};

// ─── POST /videos/:videoId/upload ────────────────────────────────────────────

/**
 * Stream a video binary to Bunny — no buffering, no temp files.
 * Uses busboy to parse the multipart form and pipe the file part directly.
 *
 * Auth: authenticateToken + authorizeAdmin (admin only)
 * Body: multipart/form-data with field name "video"
 *
 * State transitions enforced: PENDING|FAILED → UPLOADING → PROCESSING|FAILED
 *
 * IMPORTANT: This handler does NOT call next() in the normal success path —
 * it sends the response inside the busboy file event after the upload resolves.
 */
const uploadBunnyVideo = async (req, res, next) => {
  const videoId = parseInt(req.params.videoId, 10);

  if (!videoId || isNaN(videoId)) {
    return next(new AppError('Invalid video ID', 400, ErrorCodes.VIDEO_NOT_FOUND));
  }

  // Load video and verify it exists
  const video = await bunnyVideoService.findById(videoId);
  if (!video) {
    return next(new AppError('Video not found', 404, ErrorCodes.VIDEO_NOT_FOUND));
  }

  // Ownership is already verified by authorizeAdmin (admin owns all videos).
  // State machine check: only PENDING or FAILED videos can be (re-)uploaded.
  if (!['PENDING', 'FAILED'].includes(video.status)) {
    return next(new AppError(
      `Cannot upload to a video in state: ${video.status}`,
      422,
      ErrorCodes.INVALID_VIDEO_STATE
    ));
  }

  // Transition to UPLOADING before we touch any streams
  await bunnyVideoService.transitionStatus(videoId, 'UPLOADING');
  log.info('video.upload.started', {
    videoId,
    courseId: video.courseId,
    bunnyVideoId: video.bunnyVideoId,
  });

  const maxBytes = Number(process.env.BUNNY_VIDEO_MAX_BYTES) || 5 * 1024 * 1024 * 1024;

  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } });
  } catch (err) {
    // busboy throws synchronously if Content-Type is not multipart
    await bunnyVideoService.markFailed(videoId, 'Invalid Content-Type: expected multipart/form-data');
    return next(new AppError('Request must be multipart/form-data', 400, ErrorCodes.INVALID_VIDEO_FILE));
  }

  let fileHandled = false;
  let uploadSettled = false; // prevent double-calling next()

  // ── File handler: runs when busboy finds the "video" field ──────────────────
  bb.on('file', (fieldName, fileStream, info) => {
    // Only accept the "video" field; drain and discard anything else
    if (fieldName !== 'video') {
      fileStream.resume();
      return;
    }

    // Validate MIME type from busboy info (server-parsed, not client-trusted directly —
    // we use it as a hint; Bunny will also validate the actual bitstream)
    const mimeType = (info.mimeType || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      fileStream.resume(); // drain stream to avoid hanging connection
      bb.destroy();
      if (!uploadSettled) {
        uploadSettled = true;
        bunnyVideoService.markFailed(videoId, `Invalid MIME type: ${mimeType}`).then(() => {
          next(new AppError(
            `File type not allowed. Accepted types: mp4, mov, mkv, avi, webm`,
            415,
            ErrorCodes.INVALID_VIDEO_FILE
          ));
        }).catch(next);
      }
      return;
    }

    fileHandled = true;

    // Size limit handler: busboy emits 'limit' event when fileSize limit is hit
    fileStream.on('limit', () => {
      log.warn('video.upload.size_limit_exceeded', { videoId, maxBytes });
      bb.destroy(new Error('VIDEO_TOO_LARGE'));
    });

    // Stream file directly to Bunny — no intermediate storage
    bunnyClient
      .uploadVideoStream({ bunnyVideoId: video.bunnyVideoId, fileStream })
      .then(() => bunnyVideoService.transitionStatus(videoId, 'PROCESSING'))
      .then(() => {
        log.info('video.upload.completed', {
          videoId,
          courseId: video.courseId,
          bunnyVideoId: video.bunnyVideoId,
        });
        if (!uploadSettled) {
          uploadSettled = true;
          res.json({
            success: true,
            data: {
              videoId,
              status: 'PROCESSING',
              message: 'Upload complete. Video is now encoding on Bunny Stream.',
            },
          });
        }
      })
      .catch(async (err) => {
        if (!uploadSettled) {
          uploadSettled = true;
          log.error('video.upload.failed', {
            videoId,
            bunnyVideoId: video.bunnyVideoId,
            error: err.message,
          });
          await bunnyVideoService.markFailed(videoId, err.message).catch(() => {});
          next(new AppError('Upload to Bunny Stream failed', 502, ErrorCodes.VIDEO_UPLOAD_FAILED));
        }
      });
  });

  // ── Busboy error handler ────────────────────────────────────────────────────
  bb.on('error', async (err) => {
    if (uploadSettled) return;
    uploadSettled = true;

    const isTooLarge = err.message === 'VIDEO_TOO_LARGE';
    await bunnyVideoService.markFailed(videoId, err.message).catch(() => {});

    next(new AppError(
      isTooLarge ? `File exceeds maximum allowed size (${maxBytes} bytes)` : 'Upload processing error',
      isTooLarge ? 413 : 500,
      isTooLarge ? ErrorCodes.VIDEO_TOO_LARGE : ErrorCodes.VIDEO_UPLOAD_FAILED
    ));
  });

  // ── Client abort ───────────────────────────────────────────────────────────
  req.on('aborted', async () => {
    if (!uploadSettled && !res.writableEnded) {
      uploadSettled = true;
      log.warn('video.upload.client_aborted', { videoId });
      await bunnyVideoService.markFailed(videoId, 'Client aborted upload').catch(() => {});
    }
  });

  // ── Finish: no "video" field was found ─────────────────────────────────────
  bb.on('finish', () => {
    if (!fileHandled && !uploadSettled) {
      uploadSettled = true;
      bunnyVideoService.markFailed(videoId, 'No video field in request').then(() => {
        next(new AppError(
          'No "video" file field found in the request. Send the file with field name "video".',
          400,
          ErrorCodes.INVALID_VIDEO_FILE
        ));
      }).catch(next);
    }
  });

  req.pipe(bb);
};

// ─── GET /videos/:videoId/playback ───────────────────────────────────────────

/**
 * Return a signed Bunny embed URL for a READY video.
 * Auth: authenticateToken (students + admins)
 * Auth check: enrollment verified server-side using req.user.id from JWT
 *
 * ADMIN bypass: admins skip enrollment check since they manage all content.
 */
const getBunnyVideoPlayback = async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.videoId, 10);

    if (!videoId || isNaN(videoId)) {
      return next(new AppError('Invalid video ID', 400, ErrorCodes.VIDEO_NOT_FOUND));
    }

    const userId = req.user.id;     // Always from JWT — never from params/body
    const userRole = req.user.role;

    // ADMIN bypass: can access any video without enrollment check
    if (userRole === 'ADMIN') {
      const video = await bunnyVideoService.findById(videoId);
      if (!video) {
        return next(new AppError('Video not found', 404, ErrorCodes.VIDEO_NOT_FOUND));
      }
      if (video.status !== 'READY') {
        return next(new AppError(
          `Video is not ready for playback (current status: ${video.status})`,
          422,
          ErrorCodes.VIDEO_NOT_READY
        ));
      }
      const { token, expiresAt } = bunnyClient.generatePlaybackToken(video.bunnyVideoId);
      const playbackUrl = `https://iframe.mediadelivery.net/embed/${video.bunnyLibraryId}/${video.bunnyVideoId}?token=${token}&expires=${expiresAt}`;
      return res.json({ success: true, data: { videoId: video.id, playbackUrl, expiresAt } });
    }

    // Student path: enrollment + READY checks enforced in service
    const result = await bunnyVideoService.getPlaybackAccess(videoId, userId);

    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
};

// ─── DELETE /videos/bunny/:videoId ───────────────────────────────────────────

/**
 * Delete a Bunny video from Bunny Stream and local DB.
 * Auth: authenticateToken + authorizeAdmin (admin only)
 */
const deleteBunnyVideo = async (req, res, next) => {
  try {
    const videoId = parseInt(req.params.videoId, 10);

    if (!videoId || isNaN(videoId)) {
      return next(new AppError('Invalid video ID', 400, ErrorCodes.VIDEO_NOT_FOUND));
    }

    const result = await bunnyVideoService.deleteVideo(videoId);

    return res.json({
      success: true,
      data: {
        id: result.id,
        bunnyVideoId: result.bunnyVideoId,
        message: 'Video successfully deleted from Bunny Stream and database.',
      },
    });
  } catch (err) {
    return next(err);
  }
};

// ─── GET /courses/:courseId/bunny-videos ──────────────────────────────────────

/**
 * List all Bunny videos for a given course.
 * Auth: authenticateToken (Admin sees all statuses; Student sees READY only after enrollment verification)
 */
const listCourseBunnyVideos = async (req, res, next) => {
  try {
    const courseId = parseInt(req.params.courseId, 10);

    if (!courseId || isNaN(courseId)) {
      return next(new AppError('Invalid course ID', 400, ErrorCodes.COURSE_NOT_FOUND));
    }

    const userId = req.user.id;
    const role = req.user.role;

    const videos = await bunnyVideoService.listCourseVideos(courseId, userId, role);

    return res.json({
      success: true,
      data: videos,
    });
  } catch (err) {
    return next(err);
  }
};

// ─── PUT /courses/:courseId/reorder ──────────────────────────────────────────

/**
 * Reorder videos within a course.
 * Auth: authenticateToken + authorizeAdmin (admin only)
 *
 * Body: { videoIds: number[] } — BunnyVideo IDs in the desired order.
 * Positions are reassigned 1-based in the submitted order.
 */
const reorderCourseVideos = async (req, res, next) => {
  try {
    const courseId = parseInt(req.params.courseId, 10);
    const { videoIds } = req.body;

    if (!courseId || isNaN(courseId)) {
      return next(new AppError('Invalid course ID', 400, ErrorCodes.COURSE_NOT_FOUND));
    }

    const videos = await bunnyVideoService.reorderVideos(courseId, videoIds, req.user.id);

    return res.json({
      success: true,
      data: videos,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  createBunnyVideo,
  uploadBunnyVideo,
  getBunnyVideoPlayback,
  deleteBunnyVideo,
  listCourseBunnyVideos,
  reorderCourseVideos,
};
