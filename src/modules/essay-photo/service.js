'use strict';

const crypto = require('crypto');
const defaultPrisma = require('../../config/db');
const { AppError } = require('../../utils/AppError');
const defaultConfig = require('./config');
const { extractFieldsSchema } = require('./schema');
const { PROMPT_VERSION } = require('./prompt');
const defaultImageProcessor = require('./imageProcessor');
const defaultGeminiProvider = require('./geminiProvider');
const { defaultGuardrails } = require('./guardrails');

function hashStudentId(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex');
}

function countUnreadable(text) {
  return (String(text || '').match(/\[\?\]/g) || []).length;
}

function createEssayPhotoService(deps = {}) {
  const prisma = deps.prisma || defaultPrisma;
  const config = { ...defaultConfig, ...(deps.config || {}) };
  const imageProcessor = deps.imageProcessor || defaultImageProcessor;
  const geminiProvider = deps.geminiProvider || defaultGeminiProvider;
  const guardrails = deps.guardrails || defaultGuardrails;

  async function extractWithFallback(imageBuffer, mimeType) {
    try {
      return await geminiProvider.extract({ imageBuffer, mimeType, model: config.model });
    } catch (err) {
      const canFallback =
        config.fallbackModel &&
        config.fallbackModel !== config.model &&
        (err.statusCode === 429 || err.statusCode === 503 || err.statusCode === 504);
      if (!canFallback) throw err;
      return geminiProvider.extract({
        imageBuffer,
        mimeType,
        model: config.fallbackModel,
      });
    }
  }

  async function extractEssayPhoto({
    userId,
    userRole,
    examId: rawExamId,
    attemptId: rawAttemptId,
    questionId: rawQuestionId,
    imageBuffer,
  }) {
    if (!config.enabled) {
      throw new AppError('Essay photo extraction is disabled.', 503, 'ESSAY_PHOTO_DISABLED');
    }

    const parsed = extractFieldsSchema.safeParse({
      examId: rawExamId,
      attemptId: rawAttemptId,
      questionId: rawQuestionId,
    });
    if (!parsed.success) {
      throw new AppError('Invalid extraction parameters.', 400, 'INVALID_REQUEST');
    }
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new AppError('Image file is required.', 400, 'IMAGE_REQUIRED');
    }

    const { attemptId, questionId } = parsed.data;

    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        quizId: true,
        userId: true,
        status: true,
        quiz: {
          select: {
            bunnyVideo: { select: { course: { select: { teacherId: true } } } },
          },
        },
      },
    });

    if (!attempt) {
      throw new AppError('Quiz attempt not found.', 404, 'ATTEMPT_NOT_FOUND');
    }
    if (userRole !== 'ADMIN' && attempt.userId !== userId) {
      throw new AppError('You do not own this quiz attempt.', 403, 'FORBIDDEN');
    }
    if (parsed.data.examId && parsed.data.examId !== attempt.quizId) {
      throw new AppError('Attempt does not belong to this exam.', 400, 'EXAM_ATTEMPT_MISMATCH');
    }

    const examId = parsed.data.examId || attempt.quizId;
    const teacherId = attempt.quiz?.bunnyVideo?.course?.teacherId || 0;

    const processed = await imageProcessor.processImage(imageBuffer);
    const dedupKey = `${attemptId}:${questionId}:${processed.sha256}`;

    const cached = await guardrails.getDedup(dedupKey);
    if (cached) {
      const usedAttempts = await guardrails.getExamAttempts(attemptId);
      return {
        ...cached,
        remainingExamAttempts: Math.max(0, config.maxAttemptsPerExam - usedAttempts),
        cached: true,
      };
    }

    await guardrails.checkBurst(userId);
    await guardrails.checkExamAttempts(attemptId);
    await guardrails.checkBudgets();

    const extraction = await guardrails.withConcurrencyLimit(() =>
      extractWithFallback(processed.buffer, processed.mimeType)
    );

    const unreadableCount = countUnreadable(extraction.text);
    const newAttempts = await guardrails.incrementExamAttempts(attemptId);
    await guardrails.recordCost(extraction.estimatedCostUsd);

    const row = await prisma.essayPhotoExtraction.create({
      data: {
        teacherId,
        examId,
        attemptId,
        questionId,
        studentIdHash: hashStudentId(userId),
        imageSha256: processed.sha256,
        modelId: extraction.modelId,
        promptVersion: PROMPT_VERSION,
        unreadableCount,
        imageQuality: extraction.imageQuality,
        inputTokens: extraction.inputTokens,
        outputTokens: extraction.outputTokens,
        thinkingTokens: extraction.thinkingTokens,
        estimatedCostUsd: extraction.estimatedCostUsd,
        latencyMs: extraction.latencyMs,
        status: 'SUCCESS',
      },
      select: { id: true },
    });

    const payload = {
      extractionId: row.id,
      text: extraction.text,
      unreadableCount,
      imageQuality: extraction.imageQuality,
      detectedLanguage: extraction.detectedLanguage,
      warnings: extraction.warnings,
    };

    await guardrails.setDedup(dedupKey, payload);

    return {
      ...payload,
      remainingExamAttempts: Math.max(0, config.maxAttemptsPerExam - newAttempts),
      cached: false,
    };
  }

  return { extractEssayPhoto };
}

const defaultService = createEssayPhotoService();

module.exports = {
  createEssayPhotoService,
  extractEssayPhoto: defaultService.extractEssayPhoto,
  countUnreadable,
};
