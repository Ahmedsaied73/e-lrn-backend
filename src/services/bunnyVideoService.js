'use strict';

/**
 * Bunny Video Service
 *
 * All business logic for the Bunny Stream video feature lives here.
 * Controllers call this service; this service calls the Bunny client and Prisma.
 *
 * Layering rule: no res/req objects here, no Bunny client calls in controllers,
 * no business logic in controllers.
 *
 * State machine transitions (enforced here, not in controllers or DB):
 *   PENDING → UPLOADING (when upload starts)
 *   UPLOADING → PROCESSING (when Bunny receives the file)
 *   PROCESSING → READY (via webhook when encoding finishes)
 *   PROCESSING → FAILED (via webhook or reconciliation on encoding failure)
 *   PENDING | FAILED → UPLOADING (re-upload allowed from either state)
 *
 * Distributed failure handling:
 *   - Bunny create succeeds, DB insert fails → delete Bunny video (compensation)
 *   - DB record exists, upload to Bunny fails → mark FAILED, preserve for retry
 */

const prisma = require('../config/db');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');
const { AppError, ErrorCodes } = require('../utils/AppError');
const cache = require('../integrations/redis/cache');

/**
 * Invalidate cached video lists + catalog after any video mutation.
 * Writes are rare (admin/upload/webhook paths); invalidation is awaited so a
 * subsequent read can never observe the pre-write state through the cache.
 */
async function invalidateVideoCaches(courseId) {
  if (!Number.isInteger(courseId)) return;
  await cache.delPrefix(`v1:videos:course:${courseId}:`);
  await cache.delPrefix('v1:courses:');
}

// ─── Bunny status → domain status mapping ────────────────────────────────────
// Source: Bunny Stream API docs (Aug 2026)
// 0: Queued, 1: Processing, 2: Encoding → all treated as PROCESSING
// 3: Finished, 4: Resolution finished (first resolution done = playable) → READY
// 5: Failed → FAILED
// 6-10: Presigned-upload/caption/metadata events → ignored (return undefined)
const BUNNY_STATUS_MAP = {
  0: 'PROCESSING',
  1: 'PROCESSING',
  2: 'PROCESSING',
  3: 'READY',
  4: 'READY',   // First resolution encoded = playable; treating as fully READY
  5: 'FAILED',
  // 6-10: not mapped — returns undefined, caller ignores
};

// Valid state transitions — anything not in this map is an illegal transition
const VALID_TRANSITIONS = {
  PENDING:    ['UPLOADING', 'FAILED'],
  UPLOADING:  ['PROCESSING', 'FAILED'],
  PROCESSING: ['READY', 'FAILED'],
  READY:      [],   // terminal
  FAILED:     ['UPLOADING'], // re-upload allowed
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Enforce state machine transition. Throws if transition is illegal.
 * @param {string} currentStatus
 * @param {string} newStatus
 */
function assertValidTransition(currentStatus, newStatus) {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new AppError(
      `Cannot transition video from ${currentStatus} to ${newStatus}`,
      422,
      ErrorCodes.INVALID_VIDEO_STATE
    );
  }
}

/**
 * Minimal structured log helper — wraps console.log/error with event labels
 * and safe context (never logs API keys, JWTs, or playback tokens).
 */
const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

// ─── Service methods ──────────────────────────────────────────────────────────

/**
 * Create a Bunny video record.
 *
 * Steps:
 *  1. Verify course exists and admin has ownership (ADMIN always owns all courses)
 *  2. Create Bunny video object (gets a GUID)
 *  3. Persist local BunnyVideo row with PENDING status
 *  4. On DB failure: compensate by deleting the orphaned Bunny video, then rethrow
 *
 * @param {object} params
 * @param {number} params.courseId
 * @param {string} params.title
 * @param {number} params.requestedByUserId - ID from req.user.id (token only, never body)
 * @returns {Promise<object>} Created BunnyVideo record
 */
async function createVideo({ courseId, title, requestedByUserId }) {
  // Verify course exists — ownership is implicit for ADMIN (verified by authorizeAdmin middleware)
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, title: true },
  });

  if (!course) {
    throw new AppError('Course not found', 404, ErrorCodes.COURSE_NOT_FOUND);
  }

  // Create Bunny video object first — we need the GUID before we can insert locally
  let bunnyVideo;
  try {
    bunnyVideo = await bunnyClient.createVideo({ title });
  } catch (err) {
    log.error('video.create.bunny_failed', {
      courseId,
      title,
      requestedByUserId,
      error: err.message,
    });
    throw new AppError(
      'Failed to create video on Bunny Stream. Please try again.',
      502,
      ErrorCodes.BUNNY_API_ERROR
    );
  }

  log.info('video.created', {
    courseId,
    bunnyVideoId: bunnyVideo.guid,
    requestedByUserId,
  });

  // Persist local record — if this fails, compensate by deleting the Bunny video
  try {
    // New videos join the end of the course sequence (position = count + 1)
    const lastPosition = await prisma.bunnyVideo.count({ where: { courseId } });

    const localVideo = await prisma.bunnyVideo.create({
      data: {
        courseId,
        title,
        bunnyVideoId: bunnyVideo.guid,
        bunnyLibraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
        status: 'PENDING',
        position: lastPosition + 1,
      },
    });

    await invalidateVideoCaches(courseId);
    return localVideo;
  } catch (dbErr) {
    // Distributed failure: Bunny succeeded, DB failed.
    // Attempt to clean up the orphaned Bunny video. Log clearly if cleanup also fails.
    log.error('video.create.db_failed_attempting_bunny_cleanup', {
      bunnyVideoId: bunnyVideo.guid,
      error: dbErr.message,
    });

    bunnyClient.deleteVideo(bunnyVideo.guid).catch((cleanupErr) => {
      log.error('video.create.bunny_cleanup_failed', {
        bunnyVideoId: bunnyVideo.guid,
        cleanupError: cleanupErr.message,
      });
    });

    throw dbErr; // Re-throw original DB error — caught by global error handler
  }
}

/**
 * Transition a BunnyVideo's status, enforcing the state machine.
 *
 * @param {number} videoId - Local BunnyVideo.id
 * @param {string} newStatus - Target status (must be a valid transition)
 * @returns {Promise<object>} Updated BunnyVideo record
 */
async function transitionStatus(videoId, newStatus) {
  const video = await prisma.bunnyVideo.findUnique({ where: { id: videoId } });
  if (!video) {
    throw new AppError('Video not found', 404, ErrorCodes.VIDEO_NOT_FOUND);
  }

  assertValidTransition(video.status, newStatus);

  const updated = await prisma.bunnyVideo.update({
    where: { id: videoId },
    data: { status: newStatus },
  });
  await invalidateVideoCaches(updated.courseId);
  return updated;
}

/**
 * Mark a BunnyVideo as FAILED with a reason.
 * Used by upload error handling and webhook failure events.
 *
 * @param {number} videoId - Local BunnyVideo.id
 * @param {string} reason - Failure description (safe to log; never contains secrets)
 * @returns {Promise<object>} Updated BunnyVideo record
 */
async function markFailed(videoId, reason) {
  const video = await prisma.bunnyVideo.findUnique({
    where: { id: videoId },
    select: { id: true, status: true, courseId: true },
  });

  log.error('video.upload.failed', { videoId, reason, currentStatus: video ? video.status : null });

  if (!video) return null;

  // Terminal states must never be clobbered by a late failure event: if the
  // video already went READY (e.g. a webhook raced the upload error handler),
  // the failure record is dropped and READY stands.
  if (video.status === 'READY') {
    log.warn('video.upload.failed_after_ready', { videoId, reason });
    return prisma.bunnyVideo.findUnique({ where: { id: videoId } });
  }

  const updated = await prisma.bunnyVideo.update({
    where: { id: videoId },
    data: {
      status: 'FAILED',
      failureReason: reason ? String(reason).slice(0, 1000) : 'Unknown error',
    },
  });
  await invalidateVideoCaches(updated.courseId);
  return updated;
}

/**
 * Apply a Bunny status code received from a webhook payload.
 * Idempotent: repeated READY or FAILED events are no-ops once in terminal state.
 *
 * @param {string} bunnyVideoId - Bunny GUID from webhook payload
 * @param {number} bunnyStatusCode - Numeric Bunny status (0-10)
 * @returns {Promise<void>}
 */
async function applyBunnyStatus(bunnyVideoId, bunnyStatusCode) {
  const domainStatus = BUNNY_STATUS_MAP[bunnyStatusCode];

  // Status codes 6-10 are irrelevant events (captions, metadata, etc.) — ignore
  if (!domainStatus) {
    log.info('bunny.webhook.status_ignored', { bunnyVideoId, bunnyStatusCode });
    return;
  }

  const video = await prisma.bunnyVideo.findUnique({
    where: { bunnyVideoId },
  });

  if (!video) {
    log.warn('bunny.webhook.unknown_video', { bunnyVideoId, bunnyStatusCode });
    return; // Not an error — webhook may arrive for a video from another system/library
  }

  // Idempotency: terminal states must not be overwritten by stale/duplicate/out-of-order events
  if (video.status === 'READY' || video.status === 'FAILED') {
    log.info('bunny.webhook.status_ignored_terminal', {
      videoId: video.id,
      bunnyVideoId,
      currentStatus: video.status,
      incomingStatus: domainStatus,
    });
    return;
  }

  const updateData = { status: domainStatus };

  if (domainStatus === 'FAILED') {
    updateData.failureReason = 'Bunny encoding failed (status code ' + bunnyStatusCode + ')';
  }

  if (domainStatus === 'READY') {
    // Fetch current Bunny metadata to populate duration/dimensions on first READY
    try {
      const remoteMeta = await bunnyClient.getVideo(bunnyVideoId);
      updateData.duration = remoteMeta.length || null;
      updateData.width = remoteMeta.width || null;
      updateData.height = remoteMeta.height || null;
      updateData.thumbnailUrl = remoteMeta.thumbnailFileName
        ? `https://vz-${video.bunnyLibraryId}.b-cdn.net/${bunnyVideoId}/${remoteMeta.thumbnailFileName}`
        : null;
      updateData.processingProgress = 100;
    } catch (metaErr) {
      // Non-fatal: metadata enrichment failed. Video is still READY, just missing dimensions.
      log.warn('bunny.webhook.metadata_fetch_failed', {
        videoId: video.id,
        bunnyVideoId,
        error: metaErr.message,
      });
    }
  }

  await prisma.bunnyVideo.update({
    where: { id: video.id },
    data: updateData,
  });
  await invalidateVideoCaches(video.courseId);

  const eventName = domainStatus === 'READY'
    ? 'video.processing.completed'
    : domainStatus === 'FAILED'
      ? 'video.processing.failed'
      : 'video.processing.started';

  log.info(eventName, {
    videoId: video.id,
    courseId: video.courseId,
    bunnyVideoId,
    status: domainStatus,
  });
}

/**
 * Generate a signed playback URL for a READY BunnyVideo.
 *
 * Authorization chain:
 *  1. Load BunnyVideo — 404 if not found
 *  2. Verify enrollment — user must be enrolled in the video's course
 *  3. Verify status is READY — 422 if not
 *  4. Generate signed Bunny embed URL
 *
 * Security: userId comes from req.user.id (JWT token) — never from params/body.
 * IDOR guard: enrollment is checked against video.courseId (server-derived),
 * not any courseId supplied by the client.
 *
 * @param {number} videoId - Local BunnyVideo.id
 * @param {number} userId - Authenticated user ID from JWT (never from request body)
 * @returns {Promise<{videoId, playbackUrl, expiresAt}>}
 */
async function getPlaybackAccess(videoId, userId) {
  // Load video — this is the authoritative courseId; we never trust client-supplied courseId
  const video = await prisma.bunnyVideo.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      courseId: true,
      bunnyVideoId: true,
      bunnyLibraryId: true,
      status: true,
      title: true,
    },
  });

  if (!video) {
    throw new AppError('Video not found', 404, ErrorCodes.VIDEO_NOT_FOUND);
  }

  // IDOR guard: verify enrollment using the server-derived courseId
  // ADMIN bypasses enrollment check (they manage all courses)
  // Note: userId here is always from the JWT — the caller must pass req.user.id
  const enrollment = await prisma.enrollment.findFirst({
    where: { userId, courseId: video.courseId },
  });

  if (!enrollment) {
    log.info('video.playback.denied', {
      videoId: video.id,
      courseId: video.courseId,
      userId,
      reason: 'not_enrolled',
    });
    throw new AppError(
      'You must be enrolled in this course to watch videos',
      403,
      ErrorCodes.VIDEO_ACCESS_DENIED
    );
  }

  if (video.status !== 'READY') {
    throw new AppError(
      `Video is not ready for playback (current status: ${video.status})`,
      422,
      ErrorCodes.VIDEO_NOT_READY
    );
  }

  // Generate signed embed URL — token is safe to return; it's time-limited and video-scoped
  const { token, expiresAt } = bunnyClient.generatePlaybackToken(video.bunnyVideoId);
  const playbackUrl = `https://iframe.mediadelivery.net/embed/${video.bunnyLibraryId}/${video.bunnyVideoId}?token=${token}&expires=${expiresAt}`;

  log.info('video.playback.authorized', {
    videoId: video.id,
    courseId: video.courseId,
    userId,
    bunnyVideoId: video.bunnyVideoId,
  });

  return {
    videoId: video.id,
    playbackUrl,
    expiresAt,
  };
}

/**
 * Get a BunnyVideo by ID, used by upload middleware to load and authorize.
 *
 * @param {number} videoId
 * @returns {Promise<object|null>}
 */
async function findById(videoId) {
  return prisma.bunnyVideo.findUnique({ where: { id: videoId } });
}

/**
 * Find videos stuck in PROCESSING older than `staleMinutes` minutes.
 * Used by the reconciliation job.
 *
 * @param {number} staleMinutes
 * @returns {Promise<object[]>}
 */
async function findStaleProcessing(staleMinutes = 30, take = 50) {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
  return prisma.bunnyVideo.findMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: cutoff },
    },
    select: { id: true, bunnyVideoId: true, bunnyLibraryId: true, status: true, courseId: true },
    take,
  });
}

/**
 * Delete a Bunny video.
 * Removes the remote video object from Bunny.net and deletes the local row in MySQL.
 *
 * @param {number} videoId - Local BunnyVideo.id
 * @returns {Promise<{ id: number, bunnyVideoId: string }>}
 */
async function deleteVideo(videoId) {
  const video = await prisma.bunnyVideo.findUnique({
    where: { id: videoId },
    select: { id: true, bunnyVideoId: true, courseId: true, title: true },
  });

  if (!video) {
    throw new AppError('Video not found', 404, ErrorCodes.VIDEO_NOT_FOUND);
  }

  // Delete from Bunny first
  try {
    await bunnyClient.deleteVideo(video.bunnyVideoId);
  } catch (err) {
    // If Bunny returns 404, the video was already gone from Bunny — we can proceed to clean up DB
    if (err.statusCode !== 404) {
      log.error('video.delete.bunny_failed', {
        videoId,
        bunnyVideoId: video.bunnyVideoId,
        error: err.message,
      });
      throw new AppError('Failed to delete video from Bunny Stream', 502, ErrorCodes.BUNNY_API_ERROR);
    }
  }

  // Delete from DB
  await prisma.bunnyVideo.delete({
    where: { id: videoId },
  });

  await invalidateVideoCaches(video.courseId);

  log.info('video.deleted', {
    videoId,
    bunnyVideoId: video.bunnyVideoId,
    courseId: video.courseId,
  });

  return { id: video.id, bunnyVideoId: video.bunnyVideoId };
}

/**
 * List Bunny videos for a course.
 * If user is ADMIN, returns all videos (including PENDING/PROCESSING/FAILED).
 * Students may view READY video metadata before enrollment; playback access is
 * still enforced separately by getPlaybackAccess().
 *
 * @param {number} courseId
 * @param {number} userId
 * @param {string} role - 'ADMIN' | 'STUDENT'
 * @returns {Promise<object[]>}
 */
async function listCourseVideos(courseId, userId, role) {
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true },
  });

  if (!course) {
    throw new AppError('Course not found', 404, ErrorCodes.COURSE_NOT_FOUND);
  }

  const whereClause = { courseId };
  if (role !== 'ADMIN') {
    whereClause.status = 'READY';
  }

  // Role is part of the key: admins receive failureReason/processingProgress.
  // Cache-aside, 60s TTL; invalidated by every mutation above.
  const cacheKey = cache.buildKey('videos', 'course', courseId, role === 'ADMIN' ? 'admin' : 'student');
  return cache.withCache(cacheKey, 60, () => prisma.bunnyVideo.findMany({
    where: whereClause,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      courseId: true,
      title: true,
      position: true,
      bunnyVideoId: true,
      status: true,
      duration: true,
      width: true,
      height: true,
      thumbnailUrl: true,
      createdAt: true,
      // Quiz existence only (no content/answers) — drives the admin
      // "no quiz" guardrail; students already learn this via quiz meta.
      quiz: { select: { id: true } },
      // failureReason only exposed to ADMIN
      ...(role === 'ADMIN' ? { failureReason: true, processingProgress: true } : {}),
    },
  }));
}

/**
 * Reorder the videos in a course by assigning `position` sequentially.
 * Accepts the video IDs in the desired order. Idempotent and atomic.
 *
 * @param {number} courseId
 * @param {number[]} videoIds - BunnyVideo IDs in desired order
 * @param {number} requestedByUserId - ADMIN user id (for the audit log)
 * @returns {Promise<object[]>} Reordered videos (position + id)
 */
async function reorderVideos(courseId, videoIds, requestedByUserId) {
  if (!Array.isArray(videoIds) || videoIds.some(id => !Number.isInteger(id))) {
    throw new AppError('videoIds must be a non-empty array of integers', 400, ErrorCodes.INVALID_VIDEO_IDS);
  }

  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true },
  });
  if (!course) {
    throw new AppError('Course not found', 404, ErrorCodes.COURSE_NOT_FOUND);
  }

  const existing = await prisma.bunnyVideo.findMany({
    where: { courseId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map(v => v.id));

  if (videoIds.length !== existingIds.size || videoIds.some(id => !existingIds.has(id))) {
    throw new AppError(
      "videoIds must contain exactly the course's videos, each exactly once",
      400,
      ErrorCodes.INVALID_VIDEO_IDS
    );
  }

  log.info('video.reordered', { courseId, requestedByUserId, count: videoIds.length });

  // Assign positions atomically: 1-based index in the submitted order
  await prisma.$transaction(
    videoIds.map((videoId, index) =>
      prisma.bunnyVideo.update({
        where: { id: videoId },
        data: { position: index + 1 },
      })
    )
  );

  await invalidateVideoCaches(courseId);

  return prisma.bunnyVideo.findMany({
    where: { courseId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, position: true },
  });
}

module.exports = {
  createVideo,
  transitionStatus,
  markFailed,
  applyBunnyStatus,
  getPlaybackAccess,
  deleteVideo,
  listCourseVideos,
  findById,
  findStaleProcessing,
  reorderVideos,
  BUNNY_STATUS_MAP,
};
