const quizService = require('../services/quizService');

async function ensureBunnySequentialAccess(req, res, next) {
  if (req.user.role === 'ADMIN') return next();

  try {
    const gate = await quizService.evaluateGate(req.user.id, Number(req.params.videoId), req.user.role);
    if (gate.allowed) return next();

    return res.status(403).json({
      message: gate.reason,
      code: 'SEQUENTIAL_GATE',
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
