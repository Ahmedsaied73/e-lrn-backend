'use strict';

/**
 * ai-eval-rich.js — Golden test evaluation suite for AI Essay Grader Rich LaTeX & Chemistry.
 *
 * Implements Section 6.1 from MATH_INPUT_IMPLEMENTATION_PLAN.md:
 * 14 golden test cases covering:
 *   1. Equivalent math notations (0.5 vs 1/2) -> full
 *   2. Arabic variables (س, ص vs x, y) -> full
 *   3. Sign error in final answer -> partial
 *   4. Missing steps with correct final answer -> partial
 *   5. Missing units required by rubric -> deducted
 *   6. Wrong formula with correct arithmetic -> low
 *   7. Malformed equation block (\frac{1}{) -> low / unreadable
 *   8. Balanced vs unbalanced chemistry -> partial
 *   9. Alternative valid method (completing square) -> full
 *  10. Text-only answer to rich question -> full
 *  11. Mixed Arabic prose & math -> full
 *  12. Notation variations (\cdot vs \times, \dfrac vs \frac) -> full
 *  13. Indefinite integral missing +C -> deducted
 *  14. Physics vector direction wrong -> partial
 *
 * Usage:
 *   node scripts/ai-eval-rich.js          (mock offline mode, 0 API cost)
 *   node scripts/ai-eval-rich.js --real   (live model evaluation with Gemini)
 */

process.chdir(__dirname + '/..');

const { GOLDEN_CASES } = require('./golden-cases');
const { gradeEssay } = require('../src/services/aiGrader/index');

async function buildProvider(isReal) {
  if (isReal) {
    require('dotenv').config();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set for --real mode');
    const { createGeminiProvider } = require('../src/services/aiGrader/provider');
    const config = require('../src/config/env');
    return createGeminiProvider({
      apiKey,
      model: (config.aiGrader && config.aiGrader.model) || 'gemini-3.6-flash',
    });
  }

  const { createMockProvider } = require('../src/services/aiGrader/provider');
  const mockResponses = GOLDEN_CASES.map((c) => c.mockVerdict);
  return createMockProvider(mockResponses);
}

function truncateForTable(s, len = 60) {
  if (!s) return '';
  const clean = s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > len ? clean.slice(0, len - 1) + '…' : clean;
}

async function runGoldenSuite(options = {}) {
  const isReal = process.argv.includes('--real') || options.real === true;
  console.log(`\n=== Running AI Grader Rich Math & Chemistry Golden Evaluation Suite ===`);
  console.log(`Mode: ${isReal ? 'LIVE MODEL (Gemini)' : 'OFFLINE (Mock Provider)'}`);
  console.log(`Total Golden Test Cases: ${GOLDEN_CASES.length}\n`);

  const provider = await buildProvider(isReal);
  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < GOLDEN_CASES.length; i++) {
    const c = GOLDEN_CASES[i];
    if (isReal && i > 0) {
      process.stdout.write(`(waiting 13s for RPM rate limit pacing...)\n`);
      await new Promise((r) => setTimeout(r, 13000));
    }

    process.stdout.write(`[Case ${c.id}/14] ${c.name}... `);
    let attempts = 0;
    let verdict = null;
    let lastErr = null;

    while (attempts < 3) {
      attempts++;
      try {
        verdict = await gradeEssay(
          {
            questionTitle: c.question,
            studentAnswer: c.studentAnswer,
            modelAnswer: c.reference,
            rubric: c.rubric,
            maxPoints: c.maxPoints,
          },
          provider,
          { model: provider.name, timeoutMs: 45000 }
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const isRateLimit = err && err.message && err.message.includes('429');
        if (isRateLimit && attempts < 3 && isReal) {
          process.stdout.write(`[429 rate limit hit, backing off 35s (attempt ${attempts}/3)]... `);
          await new Promise((r) => setTimeout(r, 35000));
        } else {
          break;
        }
      }
    }

    if (verdict) {
      const scoreOk = verdict.score >= c.minScore && verdict.score <= c.maxScore;
      const confOk = verdict.confidence >= c.minConfidence;
      const passed = scoreOk && confOk;

      if (passed) {
        passedCount++;
        console.log(`PASS (score=${verdict.score}/${c.maxPoints}, band=${c.expectedBand}, conf=${verdict.confidence})`);
      } else {
        failedCount++;
        console.log(`FAIL (score=${verdict.score}/${c.maxPoints} want [${c.minScore}-${c.maxScore}], conf=${verdict.confidence} want >=${c.minConfidence})`);
      }
      console.log(`   Feedback: ${(verdict.feedback || '').slice(0, 150)}`);

      results.push({
        ...c,
        verdict,
        scoreOk,
        confOk,
        passed,
      });
    } else {
      failedCount++;
      console.log(`ERROR: ${lastErr ? lastErr.message : 'Unknown error'}`);
      results.push({
        ...c,
        verdict: { score: 0, confidence: 0, feedback: `Error: ${lastErr ? lastErr.message : 'Unknown error'}`, reasoning: lastErr ? lastErr.message : '' },
        passed: false,
        error: lastErr ? lastErr.message : 'Unknown error',
      });
    }
  }

  try {
    const { disconnectRedis } = require('../src/integrations/redis/redisClient');
    await disconnectRedis();
  } catch {
    /* ignore */
  }

  console.log(`\n=== Golden Evaluation Summary ===`);
  console.log(`Total: ${GOLDEN_CASES.length} | Passed: ${passedCount} | Failed: ${failedCount}`);

  // Generate markdown table
  let tableMd = `| # | Test Case | Expected Band | Score | Conf | Status | Model Feedback |\n`;
  tableMd += `|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const scoreText = `${r.verdict.score}/${r.maxPoints}`;
    const confText = r.verdict.confidence ? r.verdict.confidence.toFixed(2) : '0';
    const feedback = truncateForTable(r.verdict.feedback, 100);
    tableMd += `| ${r.id} | ${r.description} | \`${r.expectedBand}\` | ${scoreText} | ${confText} | ${status} | ${feedback} |\n`;
  }

  return { passedCount, failedCount, results, tableMd };
}

if (require.main === module) {
  runGoldenSuite()
    .then(({ failedCount }) => {
      if (failedCount > 0) {
        console.log(`\nGOLDEN SUITE FINISHED WITH ${failedCount} FAILURES`);
        process.exit(1);
      } else {
        console.log(`\nGOLDEN SUITE ALL GREEN`);
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('Fatal error running golden suite:', err);
      process.exit(1);
    });
}

module.exports = {
  runGoldenSuite,
};
