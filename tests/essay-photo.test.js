'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const sharp = require('sharp');

const prisma = require('../src/config/db');
const config = require('../src/config/env');
const { STATUS } = require('../src/config/quizConfig');
const quizService = require('../src/services/quizService');
const quizController = require('../src/controllers/quizController');
const { createEssayPhotoService, countUnreadable } = require('../src/modules/essay-photo/service');
const { createGuardrails, createMemoryStore } = require('../src/modules/essay-photo/guardrails');
const { processImage, detectImageType } = require('../src/modules/essay-photo/imageProcessor');
const { createController } = require('../src/modules/essay-photo/controller');
const { MAX_IMAGE_BYTES } = require('../src/modules/essay-photo/config');

async function makeTestJpeg(options = {}) {
  let pipeline = sharp({
    create: {
      width: options.width || 120,
      height: options.height || 80,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  });
  if (options.withExif) {
    pipeline = pipeline.withMetadata({
      exif: {
        IFD0: {
          Make: 'TestCamera',
          Model: 'ModelX',
        },
      },
    });
  }
  return pipeline.jpeg({ quality: 85 }).toBuffer();
}

function makeMockPrisma(overrides = {}) {
  const createdExtractions = [];
  return {
    createdExtractions,
    quizAttempt: {
      findUnique: async ({ where }) => ({
        id: where.id,
        quizId: 10,
        userId: 42,
        status: STATUS.IN_PROGRESS,
        quiz: {
          bunnyVideo: {
            course: { teacherId: 7 },
          },
        },
      }),
      ...overrides.quizAttempt,
    },
    essayPhotoExtraction: {
      create: async ({ data }) => {
        createdExtractions.push(data);
        return { id: `ext-${createdExtractions.length}` };
      },
      ...overrides.essayPhotoExtraction,
    },
  };
}

function makeMockGeminiProvider(responseOverrides = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async extract() {
      calls += 1;
      return {
        text: 'الحل: $x = 5$',
        unreadableCount: 0,
        imageQuality: 'GOOD',
        detectedLanguage: 'MIXED',
        warnings: [],
        modelId: 'gemini-3.1-flash-lite',
        inputTokens: 300,
        outputTokens: 40,
        thinkingTokens: 10,
        estimatedCostUsd: 0.002,
        latencyMs: 120,
        ...responseOverrides,
      };
    },
  };
}

function makeResSpy() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('imageProcessor: rejects invalid magic bytes and strips EXIF metadata via sharp', async () => {
  assert.equal(detectImageType(Buffer.from('not-an-image-at-all')), null);

  await assert.rejects(
    () => processImage(Buffer.from('GIF89a_not_supported_format_bytes')),
    (err) => err.statusCode === 422 && err.code === 'INVALID_IMAGE_TYPE'
  );

  const jpegWithExif = await makeTestJpeg({ withExif: true });
  const beforeMeta = await sharp(jpegWithExif).metadata();
  assert.ok(beforeMeta.exif, 'input JPEG should have EXIF metadata');

  const processed = await processImage(jpegWithExif);
  assert.equal(processed.mimeType, 'image/jpeg');
  assert.match(processed.sha256, /^[a-f0-9]{64}$/);

  const afterMeta = await sharp(processed.buffer).metadata();
  assert.equal(afterMeta.exif, undefined, 'EXIF metadata must be stripped');
});

test('controller: rejects multipart upload exceeding 4MB limit', async () => {
  const boundary = '----EssayPhotoTestBoundary';
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0xff);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="attemptId"\r\n\r\n1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="questionId"\r\n\r\nq1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="big.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const req = Readable.from([head, oversized, tail]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  req.user = { id: 42, role: 'STUDENT' };

  const res = makeResSpy();
  const ctrl = createController({
    extractEssayPhoto: async () => {
      throw new Error('should not reach service');
    },
  });

  await ctrl.extract(req, res);
  assert.ok(res.statusCode === 400 || res.statusCode === 422);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'IMAGE_TOO_LARGE');
});

test('service: SHA-256 deduplication returns $0 cached hit without provider call or attempt increment', async () => {
  const store = createMemoryStore();
  const guardrails = createGuardrails({ store, config: { enabled: true } });
  const mockPrisma = makeMockPrisma();
  const gemini = makeMockGeminiProvider();
  const svc = createEssayPhotoService({
    prisma: mockPrisma,
    guardrails,
    geminiProvider: gemini,
    config: { enabled: true, maxAttemptsPerExam: 10 },
  });

  const img = await makeTestJpeg();
  const first = await svc.extractEssayPhoto({
    userId: 42,
    userRole: 'STUDENT',
    examId: 10,
    attemptId: 101,
    questionId: 'q1',
    imageBuffer: img,
  });

  assert.equal(first.cached, false);
  assert.equal(first.remainingExamAttempts, 9);
  assert.equal(gemini.calls, 1);

  const second = await svc.extractEssayPhoto({
    userId: 42,
    userRole: 'STUDENT',
    examId: 10,
    attemptId: 101,
    questionId: 'q1',
    imageBuffer: img,
  });

  assert.equal(second.cached, true);
  assert.equal(second.remainingExamAttempts, 9);
  assert.equal(gemini.calls, 1);
  assert.equal(mockPrisma.createdExtractions.length, 1);
});

test('guardrails: per-exam 10-attempt cap spans multiple questions in the same attemptId (429)', async () => {
  const store = createMemoryStore();
  const guardrails = createGuardrails({
    store,
    config: { enabled: true, maxAttemptsPerExam: 10, BURST_LIMIT: 100 },
  });
  const mockPrisma = makeMockPrisma();
  const gemini = makeMockGeminiProvider();
  const svc = createEssayPhotoService({
    prisma: mockPrisma,
    guardrails,
    geminiProvider: gemini,
    config: { enabled: true, maxAttemptsPerExam: 10 },
  });

  for (let i = 0; i < 10; i += 1) {
    const img = await makeTestJpeg({ width: 100 + i, height: 80 });
    const res = await svc.extractEssayPhoto({
      userId: 42,
      userRole: 'STUDENT',
      examId: 10,
      attemptId: 202,
      questionId: `q${(i % 3) + 1}`,
      imageBuffer: img,
    });
    assert.equal(res.remainingExamAttempts, 9 - i);
  }

  const eleventhImg = await makeTestJpeg({ width: 130, height: 80 });
  await assert.rejects(
    () =>
      svc.extractEssayPhoto({
        userId: 42,
        userRole: 'STUDENT',
        examId: 10,
        attemptId: 202,
        questionId: 'q2',
        imageBuffer: eleventhImg,
      }),
    (err) => err.statusCode === 429 && err.code === 'ESSAY_PHOTO_ATTEMPT_LIMIT'
  );
});

test('guardrails: daily ($10) and monthly ($100) budget circuit breakers return 503', async () => {
  const fixedNow = () => Date.UTC(2026, 10, 24, 12, 0, 0);

  // Daily breaker ($10)
  const dailyStore = createMemoryStore(fixedNow);
  const dailyGuard = createGuardrails({
    store: dailyStore,
    nowFn: fixedNow,
    config: { dailyBudgetUsd: 10, monthlyBudgetUsd: 100 },
  });
  await dailyGuard.recordCost(10.0);
  await assert.rejects(
    () => dailyGuard.checkBudgets(),
    (err) => err.statusCode === 503 && err.code === 'ESSAY_PHOTO_BUDGET_EXCEEDED'
  );

  // Monthly breaker ($100)
  const monthlyStore = createMemoryStore(fixedNow);
  const monthlyGuard = createGuardrails({
    store: monthlyStore,
    nowFn: fixedNow,
    config: { dailyBudgetUsd: 1000, monthlyBudgetUsd: 100 },
  });
  await monthlyGuard.recordCost(100.0);
  await assert.rejects(
    () => monthlyGuard.checkBudgets(),
    (err) => err.statusCode === 503 && err.code === 'ESSAY_PHOTO_BUDGET_EXCEEDED'
  );
});

test('privacy & unreadableCount: zero image buffers or rawExtraction persisted/logged, unreadableCount recomputed server-side', async () => {
  const store = createMemoryStore();
  const guardrails = createGuardrails({ store });
  const mockPrisma = makeMockPrisma();
  const secretText = 'نص سري لا يجب حفظه [?] و [?]';
  const gemini = makeMockGeminiProvider({
    text: secretText,
    unreadableCount: 0, // intentionally wrong from model
  });
  const svc = createEssayPhotoService({
    prisma: mockPrisma,
    guardrails,
    geminiProvider: gemini,
    config: { enabled: true, maxAttemptsPerExam: 10 },
  });

  const logs = [];
  const origLog = console.log;
  const origInfo = console.info;
  console.log = (...args) => logs.push(args.join(' '));
  console.info = (...args) => logs.push(args.join(' '));

  try {
    const img = await makeTestJpeg();
    const res = await svc.extractEssayPhoto({
      userId: 42,
      userRole: 'STUDENT',
      examId: 10,
      attemptId: 303,
      questionId: 'q1',
      imageBuffer: img,
    });

    assert.equal(countUnreadable(secretText), 2);
    assert.equal(res.unreadableCount, 2);
    assert.equal(mockPrisma.createdExtractions.length, 1);

    const saved = mockPrisma.createdExtractions[0];
    assert.equal(saved.unreadableCount, 2);
    assert.equal('rawExtraction' in saved, false);
    assert.equal('text' in saved, false);
    assert.equal('imageBuffer' in saved, false);
    assert.equal('image' in saved, false);
    for (const val of Object.values(saved)) {
      assert.equal(Buffer.isBuffer(val), false);
      if (typeof val === 'string') {
        assert.equal(val.includes('نص سري'), false);
      }
    }
    assert.equal(logs.some((l) => l.includes('نص سري')), false);
  } finally {
    console.log = origLog;
    console.info = origInfo;
  }
});

test('quizService.submitAttempt: rejects [?] in plain and Envelope v1 essay answers with 422 UNRESOLVED_MARKERS', async () => {
  const origFindUnique = prisma.quizAttempt.findUnique;
  const origUpdateMany = prisma.quizAttempt.updateMany;

  prisma.quizAttempt.findUnique = async ({ where }) => ({
    id: where.id,
    userId: 42,
    quizId: 10,
    status: STATUS.IN_PROGRESS,
    deadlineAt: null,
    quizSnapshot: {
      surveyJson: {
        pages: [
          {
            elements: [
              { type: 'comment', name: 'q_plain', title: 'سؤال ١' },
              { type: 'comment', name: 'q_rich', title: 'سؤال ٢', answerFormat: 'RICH' },
            ],
          },
        ],
      },
      answerKey: {
        q_plain: { type: 'comment', points: 5, modelAnswer: 'ok' },
        q_rich: { type: 'comment', points: 5, modelAnswer: 'ok', answerFormat: 'RICH' },
      },
    },
    quiz: { id: 10, passingScore: 50 },
  });
  prisma.quizAttempt.updateMany = async () => {
    throw new Error('updateMany must not be called when [?] exists');
  };

  try {
    // Plain text [?]
    await assert.rejects(
      () =>
        quizService.submitAttempt(42, 501, {
          q_plain: 'الإجابة هي [?] سم',
          q_rich: 'نص عادي',
        }),
      (err) =>
        err.statusCode === 422 &&
        err.code === 'UNRESOLVED_MARKERS' &&
        Array.isArray(err.questionIds) &&
        err.questionIds.includes('q_plain')
    );

    // Envelope v1 [?] inside math block
    const richWithMarker = JSON.stringify({
      v: 1,
      blocks: [
        { t: 'text', v: 'المعادلة:' },
        { t: 'math', v: 'x + [?] = 5' },
      ],
    });
    await assert.rejects(
      () =>
        quizService.submitAttempt(42, 501, {
          q_plain: 'نص سليم',
          q_rich: richWithMarker,
        }),
      (err) =>
        err.statusCode === 422 &&
        err.code === 'UNRESOLVED_MARKERS' &&
        Array.isArray(err.questionIds) &&
        err.questionIds.includes('q_rich')
    );
  } finally {
    prisma.quizAttempt.findUnique = origFindUnique;
    prisma.quizAttempt.updateMany = origUpdateMany;
  }
});

test('quizService.sanitizeEssayMeta: strips rawExtraction and arbitrary fields', () => {
  const sanitized = quizService.sanitizeEssayMeta({
    q1: {
      source: 'photo',
      wasEdited: true,
      confirmedAt: '2026-11-24T20:00:00Z',
      rawExtraction: 'MUST NOT BE STORED',
      imageBase64: 'data:image/jpeg;base64,AAA',
    },
  });

  assert.deepEqual(sanitized, {
    q1: {
      source: 'photo',
      wasEdited: true,
      confirmedAt: '2026-11-24T20:00:00Z',
    },
  });
});

test('clean disable: ESSAY_PHOTO_ENABLED=false and teacher.essayPhotoEnabled=false', async () => {
  const svcDisabled = createEssayPhotoService({ config: { enabled: false } });
  const img = await makeTestJpeg();
  await assert.rejects(
    () =>
      svcDisabled.extractEssayPhoto({
        userId: 42,
        userRole: 'STUDENT',
        examId: 10,
        attemptId: 404,
        questionId: 'q1',
        imageBuffer: img,
      }),
    (err) => err.statusCode === 503 && err.code === 'ESSAY_PHOTO_DISABLED'
  );

  // quizController.startQuiz returns essayPhotoEnabled: false when teacher.essayPhotoEnabled is false
  const origVideoFind = prisma.bunnyVideo.findUnique;
  const origStartAttempt = quizService.startAttempt;
  const origEssayPhotoEnabled = config.essayPhoto.enabled;

  config.essayPhoto.enabled = true;
  prisma.bunnyVideo.findUnique = async () => ({
    id: 1,
    slug: 'vid000000001',
    courseId: 2,
    quiz: { id: 10, title: 'Quiz', surveyJson: { pages: [] }, passingScore: 50 },
    course: { teacher: { essayPhotoEnabled: false } },
  });
  quizService.startAttempt = async () => ({
    attempt: { id: 99, attemptNumber: 1, status: STATUS.IN_PROGRESS, startedAt: new Date(), deadlineAt: null },
    quiz: { id: 10, title: 'Quiz', surveyJson: { pages: [] }, passingScore: 50 },
    resumed: false,
  });

  try {
    const req = { params: { videoSlug: 'vid000000001' }, user: { id: 1, role: 'ADMIN' } };
    const res = makeResSpy();
    await quizController.startQuiz(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.essayPhotoEnabled, false);
    assert.equal(res.body.data.remainingPhotoAttempts, 10);
  } finally {
    prisma.bunnyVideo.findUnique = origVideoFind;
    quizService.startAttempt = origStartAttempt;
    config.essayPhoto.enabled = origEssayPhotoEnabled;
  }
});
