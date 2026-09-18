const prisma = require('../config/db');
const quizService = require('../services/quizService');
const { isValidSlug } = require('../utils/slugs');

async function ensureBunnySequentialAccess(req, res, next) {
  if (req.user.role === 'ADMIN') return next();

  try {
    const { videoSlug } = req.params;
    if (!isValidSlug(videoSlug)) {
      return res.status(400).json({ message: 'Invalid video slug', code: 'INVALID_SLUG' });
    }

    const video = await prisma.bunnyVideo.findUnique({
      where: { slug: videoSlug },
      select: { id: true, slug: true },
    });
    if (!video) {
      return res.status(404).json({ message: 'Video not found', code: 'VIDEO_NOT_FOUND' });
    }

    const gate = await quizService.evaluateGate(req.user.id, video.id, req.user.role);
    if (gate.allowed) {
      // Gate already fetched the video (and verified enrollment + READY status
      // ordering). Attach its slim row so the playback handler can skip the
      // redundant video re-fetch + enrollment re-check in getPlaybackAccess.
      if (gate._video) req.gateVideo = gate._video;
      return next();
    }

    // Pass the gate's structured code through (NOT_ENROLLED / SEQUENTIAL_GATE)
    // so callers can distinguish "not enrolled" from "complete the previous
    // video". Missing video is a 404; the rest are 403s. Numeric ids remain on
    // the gate object for internal flows, but the surface only exposes slugs.
    const status = gate.code === 'VIDEO_NOT_FOUND' ? 404 : 403;
    return res.status(status).json({
      message: gate.reason,
      code: gate.code,
      videoSlug,
      previousVideoSlug: gate.previousVideoSlug,
      quizSlug: gate.quizSlug,
      yourScore: gate.bestScore,
      requiredScore: gate.required,
    });
  } catch (error) {
    console.error('Bunny sequential access check error:', error);
    return res.status(500).json({ message: 'Server error while checking content access' });
  }
}

module.exports = { ensureBunnySequentialAccess };
