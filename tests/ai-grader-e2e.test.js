'use strict';

/**
 * Integration + Chaos proof against real Postgres & Redis.
 * Cleans up all synthetic records in `after()`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const quizService = require('../src/services/quizService');
const { processGradingJob } = require('../src/services/aiGrader/worker');
const { createMockProvider } = require('../src/services/aiGrader/provider');
const { reconcileAiGrading } = require('../src/jobs/reconcileAiGrading');
const { getAiGradingHealth } = require('../src/controllers/aiGraderAdminController');
const { closeGradingQueue } = require('../src/services/aiGrader/queue');

describe('AI Grader Hardening E2E (real Postgres + Redis)', () => {
  let user;
  let admin;
  let course;
  let video;
  let quiz;
  let enqueueMock;
  const createdAttemptIds = [];

  before(async () => {
    // Other agents' BullMQ workers share this Redis queue. The DB outbox rows
    // are still created by submitAttempt; suppress only the Redis enqueue so
    // no external worker can claim the jobs this suite drives directly.
    const { mock } = require('node:test');
    const gradingQueue = require('../src/services/aiGrader/queue');
    enqueueMock = mock.method(gradingQueue, 'enqueueAiGrading', async () => 0);

    const suffix = Date.now();
    user = await prisma.user.create({
      data: {
        name: 'AI Test Student',
        slug: `ai-student-${suffix}`,
        email: `ai-student-${suffix}@test.local`,
        password: 'hash',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
      },
    });
    admin = await prisma.user.create({
      data: {
        name: 'AI Test Admin',
        slug: `ai-admin-${suffix}`,
        email: `ai-admin-${suffix}@test.local`,
        password: 'hash',
        role: 'ADMIN',
        grade: 'FIRST_SECONDARY',
      },
    });
    course = await prisma.course.create({
      data: {
        title: `AI Test Course ${suffix}`,
        slug: `ai-test-course-${suffix}`,
        description: 'test',
        grade: 'FIRST_SECONDARY',
        price: 0,
        thumbnail: 'https://example.com/thumb.png',
        teacherId: admin.id,
      },
    });
    video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: `AI Test Video ${suffix}`,
        slug: `ai-test-video-${suffix}`,
        bunnyVideoId: `guid-${suffix}`,
        bunnyLibraryId: 'lib-1',
        status: 'READY',
        position: 999,
      },
    });

    const surveyJson = {
      pages: [{
        elements: [
          { type: 'comment', name: 'q_empty', title: 'Empty Question' },
          { type: 'comment', name: 'q_manual', title: 'Manual Question' },
          { type: 'comment', name: 'q_ai', title: 'Explain photosynthesis.' },
        ],
      }],
    };
    const answerKey = {
      q_empty: { type: 'comment', points: 10, modelAnswer: 'Anything', ai: { enabled: true } },
      q_manual: { type: 'comment', points: 10, modelAnswer: 'Manual key', ai: { enabled: false } },
      q_ai: { type: 'comment', points: 10, modelAnswer: 'Plants convert sunlight into chemical energy.', ai: { enabled: true } },
    };

    quiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: video.id,
        title: `AI Test Quiz ${suffix}`,
        slug: `ai-test-quiz-${suffix}`,
        passingScore: 50,
        maxAttempts: 10,
        surveyJson,
        answerKey,
        aiReviewMode: 'AUTO',
      },
    });
  });

  after(async () => {
    if (createdAttemptIds.length > 0) {
      await prisma.quizAttempt.deleteMany({ where: { id: { in: createdAttemptIds } } });
    }
    if (quiz) await prisma.quiz.delete({ where: { id: quiz.id } }).catch(() => {});
    if (video) await prisma.bunnyVideo.delete({ where: { id: video.id } }).catch(() => {});
    if (course) await prisma.course.delete({ where: { id: course.id } }).catch(() => {});
    if (user) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (admin) await prisma.user.delete({ where: { id: admin.id } }).catch(() => {});
    if (enqueueMock) enqueueMock.mock.restore();
    await closeGradingQueue().catch(() => {});
    const redisClient = require('../src/integrations/redis/redisClient');
    if (typeof redisClient.disconnectRedis === 'function') await redisClient.disconnectRedis().catch(() => {});
    await prisma.$disconnect();
  });

  it('1. Outbox creates SYSTEM_GRADED, NEEDS_REVIEW(NOT_AI_ENABLED), and PENDING atomically', async () => {
    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt.id);

    const res = await quizService.submitAttempt(user.id, attempt.id, {
      q_empty: '   ',
      q_manual: 'My manual answer',
      q_ai: 'Plants use sunlight to make glucose and oxygen.',
    });
    assert.equal(res.attempt.status, 'GRADING');

    const jobs = await prisma.aiGradingJob.findMany({
      where: { attemptId: attempt.id },
      orderBy: { questionName: 'asc' },
    });
    const byName = Object.fromEntries(jobs.map((j) => [j.questionName, j]));

    assert.equal(byName.q_empty.status, 'SYSTEM_GRADED');
    assert.equal(byName.q_manual.status, 'NEEDS_REVIEW');
    assert.equal(byName.q_manual.reason, 'NOT_AI_ENABLED');
    assert.equal(byName.q_ai.status, 'PENDING');
    assert.equal(res.attempt.essayFeedback.q_empty.awarded, 0);
    assert.equal(res.attempt.essayFeedback.q_empty.gradedBy, 'system');
  });

  it('2. Worker rejects out-of-range score (100 on max 10) instead of clamping', async () => {
    const attemptId = createdAttemptIds[0];
    const badProvider = createMockProvider([
      { score: 100, maxScore: 10, confidence: 1.0, feedback: 'Perfect!' },
      { score: 100, maxScore: 10, confidence: 1.0, feedback: 'Perfect!' },
    ]);

    const result = await processGradingJob(
      { data: { attemptId, questionName: 'q_ai' } },
      () => badProvider
    );
    assert.equal(result.escalated, true);
    assert.equal(result.reason, 'SCALE_MISMATCH');

    const job = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId, questionName: 'q_ai' } },
    });
    assert.equal(job.status, 'NEEDS_REVIEW');
    assert.equal(job.reason, 'SCALE_MISMATCH');
  });

  it('3. Worker applies valid verdict atomically, caches by inputHash, and teacher merges remaining essay', async () => {
    const attemptId = createdAttemptIds[0];
    // Reset q_ai back to PENDING for happy-path test
    await prisma.aiGradingJob.update({
      where: { attemptId_questionName: { attemptId, questionName: 'q_ai' } },
      data: { status: 'PENDING', reason: null, tries: 0, error: null, verdict: null },
    });

    const goodProvider = createMockProvider([
      { score: 9, maxScore: 10, confidence: 0.95, feedback: 'Clear and accurate explanation.', _tokensIn: 120, _tokensOut: 40 },
    ]);

    const res1 = await processGradingJob(
      { data: { attemptId, questionName: 'q_ai' } },
      () => goodProvider
    );
    assert.equal(res1.applied, true);
    assert.equal(goodProvider.calls, 1);

    const job = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId, questionName: 'q_ai' } },
    });
    assert.equal(job.status, 'DONE_APPLIED');
    assert.equal(job.tokensIn, 120);
    assert.equal(job.tokensOut, 40);
    assert.ok(job.inputHash);

    // Teacher grades ONLY q_manual — preserves q_empty (system) and q_ai (ai)
    const finalized = await quizService.gradeEssayAttempt(admin.id, attemptId, { q_manual: 8 }, { q_manual: 'Good' });
    assert.equal(finalized.status, 'GRADED');
    assert.equal(finalized.essayEarned, 17); // 0 + 9 + 8
    assert.equal(finalized.essayFeedback.q_ai.gradedBy, 'ai');
    assert.equal(finalized.essayFeedback.q_manual.gradedBy, 'human');
    assert.equal(finalized.essayFeedback.q_empty.gradedBy, 'system');

    // Second identical attempt should hit the DB verdict cache (0 model calls)
    const attempt2 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 2,
        status: 'IN_PROGRESS',
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt2.id);
    await quizService.submitAttempt(user.id, attempt2.id, {
      q_empty: '',
      q_manual: 'Manual',
      q_ai: 'Plants use sunlight to make glucose and oxygen.',
    });

    const neverCalledProvider = createMockProvider([]);
    const res2 = await processGradingJob(
      { data: { attemptId: attempt2.id, questionName: 'q_ai' } },
      () => neverCalledProvider
    );
    assert.equal(res2.applied, true);
    assert.equal(neverCalledProvider.calls, 0);
  });

  it('4. Reconciler resets expired RUNNING leases, escalates exhausted PENDING, and detects orphans', async () => {
    const attempt3 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 3,
        status: 'GRADING',
        submittedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 mins ago (orphan)
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt3.id);

    // Expired lease job
    await prisma.aiGradingJob.create({
      data: {
        attemptId: attempt3.id,
        questionName: 'q_empty',
        status: 'RUNNING',
        leaseUntil: new Date(Date.now() - 60 * 1000),
      },
    });

    // Exhausted PENDING job
    await prisma.aiGradingJob.create({
      data: {
        attemptId: attempt3.id,
        questionName: 'q_ai',
        status: 'PENDING',
        tries: 3,
        maxTries: 3,
      },
    });

    const summary = await reconcileAiGrading();
    assert.ok(summary.expiredLeases >= 1);
    assert.ok(summary.exhausted >= 1);

    const resetJob = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId: attempt3.id, questionName: 'q_empty' } },
    });
    assert.equal(resetJob.status, 'PENDING');

    const failedJob = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId: attempt3.id, questionName: 'q_ai' } },
    });
    assert.equal(failedJob.status, 'NEEDS_REVIEW');
    assert.equal(failedJob.reason, 'AI_FAILED');
  });

  it('5. Health endpoint returns 5-state breakdown', async () => {
    let payload = null;
    const mockRes = {
      status() { return this; },
      json(body) { payload = body; return this; },
    };
    await getAiGradingHealth({}, mockRes);
    assert.equal(payload.success, true);
    assert.ok('PENDING' in payload.data.byState);
    assert.ok('DONE_APPLIED' in payload.data.byState);
    assert.ok('NEEDS_REVIEW' in payload.data.byState);
    assert.ok('SYSTEM_GRADED' in payload.data.byState);
  });

  it('6. Does not claim a PENDING job whose nextRunAt is in the future', async () => {
    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 6,
        status: 'GRADING',
        submittedAt: new Date(),
        responses: { q_ai: 'Plants use sunlight to make glucose.' },
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt.id);

    await prisma.aiGradingJob.create({
      data: {
        attemptId: attempt.id,
        questionName: 'q_ai',
        status: 'PENDING',
        nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const provider = createMockProvider([{ score: 10, maxScore: 10, confidence: 0.9, feedback: 'Good.' }]);
    const result = await processGradingJob(
      { data: { attemptId: attempt.id, questionName: 'q_ai' } },
      () => provider
    );

    assert.equal(result.skipped, 'not-pending');
    assert.equal(provider.calls, 0);
  });

  it('7. Rolls back the job verdict and the attempt together when application fails', async () => {
    const { mock } = require('node:test');
    const quizService = require('../src/services/quizService');

    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 7,
        status: 'GRADING',
        submittedAt: new Date(),
        responses: { q_ai: 'Plants use sunlight to make glucose.' },
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt.id);

    await prisma.aiGradingJob.create({
      data: { attemptId: attempt.id, questionName: 'q_ai', status: 'PENDING', nextRunAt: new Date() },
    });

    const provider = createMockProvider([
      { score: 9, maxScore: 10, confidence: 0.95, feedback: 'Clear answer.' },
    ]);
    const verdictMock = mock.method(quizService, 'applyAiVerdictInTx', async () => {
      throw new Error('injected application failure');
    });

    try {
      await assert.rejects(
        () => processGradingJob({ data: { attemptId: attempt.id, questionName: 'q_ai' } }, () => provider)
      );
    } finally {
      verdictMock.mock.restore();
    }

    const job = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId: attempt.id, questionName: 'q_ai' } },
    });
    const fresh = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    assert.equal(job.status, 'RUNNING');
    assert.equal(job.verdict, null);
    assert.equal(fresh.essayFeedback, null);
  });

  it('8. Refunds the full reservation when the budget is exhausted', async () => {
    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 8,
        status: 'GRADING',
        submittedAt: new Date(),
        responses: { q_ai: 'Plants use sunlight to make glucose.' },
        quizSnapshot: { surveyJson: quiz.surveyJson, answerKey: quiz.answerKey },
      },
    });
    createdAttemptIds.push(attempt.id);

    await prisma.aiGradingJob.create({
      data: { attemptId: attempt.id, questionName: 'q_ai', status: 'PENDING', nextRunAt: new Date() },
    });

    const refunded = [];
    const provider = createMockProvider([]);
    const result = await processGradingJob(
      { data: { attemptId: attempt.id, questionName: 'q_ai' } },
      () => provider,
      { budget: { check: async () => false, refund: async (n) => refunded.push(n) } }
    );

    assert.equal(result.skipped, 'budget-deferred');
    assert.equal(refunded.length, 1);
    assert.ok(refunded[0] > 0);
  });
});
