'use strict';

const { z } = require('zod');
const aiStudentService = require('../services/aiStudent/aiStudentService');

const chatSchema = z.object({
  sessionId: z.string({ required_error: 'sessionId is required' }).trim().min(1, 'sessionId is required'),
  message: z.string({ required_error: 'message is required' }).trim().min(1, 'message is required').max(500, 'message cannot exceed 500 characters'),
});

const FRIENDLY_ERROR_MESSAGE = 'حصلت مشكلة مؤقتة، جرّب تاني بعد شوية';

/**
 * POST /ai-student/chat
 * Handles a chat message from an authenticated student.
 */
async function chat(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => i.message).join(', ');
    return res.status(400).json({ success: false, error: errorMsg });
  }

  const { sessionId, message } = parsed.data;

  try {
    const result = await aiStudentService.sendMessage({
      userId,
      sessionId,
      message,
    });

    return res.status(200).json({ reply: result.reply });
  } catch (err) {
    console.error('[AiStudent] chat failed:', (err && err.message) || err);
    if (err.status === 400) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return res.status(503).json({
      success: false,
      error: FRIENDLY_ERROR_MESSAGE,
    });
  }
}

module.exports = {
  chat,
  FRIENDLY_ERROR_MESSAGE,
};
