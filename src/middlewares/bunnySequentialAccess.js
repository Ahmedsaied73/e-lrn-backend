const quizService = require('../services/quizService');

async function ensureBunnySequentialAccess(req, res, next) {
  if (req.user.role === 'ADMIN') return next();

  try {
    const gate = await quizService.evaluateGate(req.user.id, Number(req.params.videoId), req.user.role);
    if (gate.allowed) return next();

    // Pass the gate's structured code through (NOT_ENROLLED / SEQUENTIAL_GATE)
    // so callers can distinguish "not enrolled" from "complete the previous
    // video". Missing video is a 404; the rest are 403s.
    const status = gate.code === 'VIDEO_NOT_FOUND' ? 404 : 403;
    return res.status(status).json({
      message: gate.reason,
      code: gate.code,
      previousVideoId: gate.previousVideoId,
      quizId: gate.quizId,
      yourScore: gate.bestScore,
      requiredScore: gate.required,
    });
  } catch (error) {
    console.error('Bunny sequential access check error:', error);
    return res.status(500).json({ message: 'Server error while checking content access' });
  }
}

module.exports = { ensureBunnySequentialAccess };
