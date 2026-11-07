'use strict';
require('dotenv').config();
const prisma = require('../src/config/db');

async function verify() {
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('Verifying Seeded Thanaweya Math Quiz in Database...');
  console.log('─────────────────────────────────────────────────────────────────');

  const quiz = await prisma.quiz.findFirst({
    where: { title: 'امتحان الرياضيات - الثانوية العامة (تالتة ثانوي)' },
    include: {
      bunnyVideo: {
        include: {
          course: true,
          progress: {
            include: { user: { select: { email: true, role: true } } },
          },
        },
      },
    },
  });

  if (!quiz) {
    throw new Error('FAIL: Quiz not found in database');
  }

  console.log(`[PASS] Quiz found: ID=${quiz.id}, Slug=${quiz.slug}`);
  console.log(`[PASS] Video: #${quiz.bunnyVideo.id} "${quiz.bunnyVideo.title}" (slug: ${quiz.bunnyVideo.slug})`);
  console.log(`[PASS] Course: #${quiz.bunnyVideo.course.id} "${quiz.bunnyVideo.course.title}" (slug: ${quiz.bunnyVideo.course.slug})`);

  const elements = quiz.surveyJson?.pages?.[0]?.elements || [];
  if (elements.length !== 20) {
    throw new Error(`FAIL: Expected 20 questions in surveyJson, found ${elements.length}`);
  }
  console.log(`[PASS] SurveyJS Elements count: ${elements.length}`);

  const mcqs = elements.filter((e) => e.type === 'radiogroup');
  const essays = elements.filter((e) => e.type === 'comment');

  if (mcqs.length !== 10) {
    throw new Error(`FAIL: Expected 10 MCQs, found ${mcqs.length}`);
  }
  if (essays.length !== 10) {
    throw new Error(`FAIL: Expected 10 Essays, found ${essays.length}`);
  }
  console.log(`[PASS] MCQs: ${mcqs.length}, Essays: ${essays.length}`);

  for (const essay of essays) {
    if (essay.answerFormat !== 'RICH') {
      throw new Error(`FAIL: Essay ${essay.name} has answerFormat: ${essay.answerFormat}, expected "RICH"`);
    }
  }
  console.log('[PASS] All 10 essay questions have answerFormat: "RICH"');

  const answerKey = quiz.answerKey || {};
  const keyNames = Object.keys(answerKey);
  if (keyNames.length !== 20) {
    throw new Error(`FAIL: Expected 20 keys in answerKey, found ${keyNames.length}`);
  }

  let totalPts = 0;
  for (const name of keyNames) {
    const entry = answerKey[name];
    totalPts += entry.points || 0;
    if (entry.type === 'comment') {
      if (entry.answerFormat !== 'RICH') {
        throw new Error(`FAIL: answerKey[${name}] answerFormat is ${entry.answerFormat}, expected "RICH"`);
      }
      if (!entry.modelAnswer || typeof entry.modelAnswer !== 'string') {
        throw new Error(`FAIL: answerKey[${name}] missing modelAnswer`);
      }
      if (!entry.rubric) {
        throw new Error(`FAIL: answerKey[${name}] missing rubric`);
      }
    }
  }
  console.log(`[PASS] Total points in answerKey: ${totalPts} (expected 100)`);
  if (totalPts !== 100) {
    throw new Error(`FAIL: Expected total points 100, got ${totalPts}`);
  }

  console.log(`[PASS] Unlocked video progress entries count: ${quiz.bunnyVideo.progress.length}`);
  for (const p of quiz.bunnyVideo.progress) {
    console.log(`   - User: ${p.user.email} (completed: ${p.completed})`);
  }

  console.log('\n=================================================================');
  console.log('ALL VERIFICATIONS PASSED: 100% GENUINE & ACCURATE IN DATABASE');
  console.log('=================================================================\n');
}

verify()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
