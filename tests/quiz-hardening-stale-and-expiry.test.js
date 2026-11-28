'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const config = require('../src/config/env');
const quizService = require('../src/services/quizService');
const bunnyClient = require('../src/integrations/bunny/bunnyStreamClient');
const bunnyVideoService = require('../src/services/bunnyVideoService');

describe('Quiz stale-attempt & paid-expiry hardening', () => {
  it('finalizeStaleAttempt works when passed an interactive tx client without $transaction (31-min abandoned attempt)', async () => {
    const updatedCalls = [];
    const fakeTx = {
      // Interactive transaction client intentionally has NO $transaction method
      quizAttempt: {
        update: async (args) => {
          updatedCalls.push(args);
          return {
            id: args.where.id,
            status: args.data.status,
            earnedPoints: args.data.earnedPoints,
            totalPoints: args.data.totalPoints,
            scorePercent: args.data.scorePercent,
          };
        },
      },
    };

    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000);
    const attempt = {
      id: 9991,
      startedAt: thirtyOneMinAgo,
      deadlineAt: null,
      responses: { q1: 'A' },
      quizSnapshot: {
        surveyJson: { pages: [{ elements: [{ type: 'radiogroup', name: 'q1', choices: ['A', 'B'] }] }] },
        answerKey: { q1: { type: 'radiogroup', correctValue: 'A', points: 5 } },
      },
    };
    const quiz = { id: 1, answerKey: attempt.quizSnapshot.answerKey };

    const res = await quizService.finalizeStaleAttempt(attempt, quiz, fakeTx, { deferSideEffects: true });
    assert.equal(res.status, 'GRADED');
    assert.equal(res.earnedPoints, 5);
    assert.equal(updatedCalls.length, 1);
    assert.equal(updatedCalls[0].data.autoSubmitted, true);
  });

  it('generatePlaybackToken + computeClampedTokenTtl never mint past enrollment.expiresAt', () => {
    const origPay = config.features.payments;
    const origPaymob = config.paymob.enabled;
    try {
      config.features.payments = true;
      config.paymob.enabled = true;

      const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
      const ttl = bunnyVideoService.computeClampedTokenTtl(fiveMinFromNow);
      assert.ok(ttl > 0 && ttl <= 300, `expected clamped ttl <= 300s, got ${ttl}`);

      const nowSec = Math.floor(Date.now() / 1000);
      const { expiresAt } = bunnyClient.generatePlaybackToken('vid-123', ttl);
      assert.ok(expiresAt <= nowSec + ttl + 1, `expiresAt ${expiresAt} exceeded now + ${ttl}`);

      const past = new Date(Date.now() - 10 * 1000);
      assert.throws(() => bunnyVideoService.computeClampedTokenTtl(past), { code: 'ACCESS_EXPIRED' });
    } finally {
      config.features.payments = origPay;
      config.paymob.enabled = origPaymob;
    }
  });

  it('submitAttempt rejects expired enrollment when payments are enabled', async () => {
    const origPay = config.features.payments;
    const origPaymob = config.paymob.enabled;
    const origAttemptFind = prisma.quizAttempt.findUnique;
    const origEnrollFind = prisma.enrollment.findFirst;
    try {
      config.features.payments = true;
      config.paymob.enabled = true;

      prisma.quizAttempt.findUnique = async () => ({
        id: 1,
        userId: 42,
        status: 'IN_PROGRESS',
        deadlineAt: null,
        quiz: { bunnyVideo: { courseId: 77 }, answerKey: {}, surveyJson: {} },
      });
      prisma.enrollment.findFirst = async () => ({
        id: 10,
        isPaid: true,
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      await assert.rejects(
        () => quizService.submitAttempt(42, 1, { q1: 'A' }, false),
        (err) => err.statusCode === 403 && err.code === 'ACCESS_EXPIRED'
      );
    } finally {
      config.features.payments = origPay;
      config.paymob.enabled = origPaymob;
      prisma.quizAttempt.findUnique = origAttemptFind;
      prisma.enrollment.findFirst = origEnrollFind;
    }
  });
});
