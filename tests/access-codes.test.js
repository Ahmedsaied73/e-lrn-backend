'use strict';

process.env.ACCESS_CODES_ENABLED = 'true';
process.chdir(__dirname + '/..');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const accessCodeService = require('../src/services/accessCodes/accessCodeService');
const { randomBase36Slug } = require('../src/utils/slugs');
const { createToken } = require('../src/utils');
const config = require('../src/config/env');

describe('Access Codes Service & Lifecycle Integration Suite', { concurrency: 1 }, () => {
  let testAdmin;
  let testStudent1;
  let testStudent2;
  let testCourse;
  const createdBatchIds = [];
  const createdCourseIds = [];

  before(async () => {
    // Create test admin
    testAdmin = await prisma.user.create({
      data: {
        name: 'Test Admin AC',
        email: `admin.ac.${Date.now()}@test.local`,
        password: 'Password123!',
        role: 'ADMIN',
        grade: 'FIRST_SECONDARY',
        slug: randomBase36Slug(),
      },
    });

    // Create test students
    testStudent1 = await prisma.user.create({
      data: {
        name: 'Test Student 1 AC',
        email: `student1.ac.${Date.now()}@test.local`,
        password: 'Password123!',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
        slug: randomBase36Slug(),
      },
    });

    testStudent2 = await prisma.user.create({
      data: {
        name: 'Test Student 2 AC',
        email: `student2.ac.${Date.now()}@test.local`,
        password: 'Password123!',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
        slug: randomBase36Slug(),
      },
    });

    // Create test course
    testCourse = await prisma.course.create({
      data: {
        title: 'كورس تجريبي لأكواد التفعيل',
        slug: randomBase36Slug(),
        description: 'وصف كورس تجريبي',
        price: 150,
        thumbnail: 'https://example.com/thumb.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: testAdmin.id,
      },
    });
  });

  after(async () => {
    // Net-zero cleanup
    if (createdBatchIds.length > 0) {
      await prisma.accessCode.deleteMany({
        where: { batchId: { in: createdBatchIds } },
      });
      await prisma.accessBatch.deleteMany({
        where: { id: { in: createdBatchIds } },
      });
    }

    const allCourseIds = [testCourse?.id, ...createdCourseIds].filter(Boolean);
    if (allCourseIds.length > 0) {
      await prisma.enrollment.deleteMany({
        where: { courseId: { in: allCourseIds } },
      });
      await prisma.course.deleteMany({
        where: { id: { in: allCourseIds } },
      });
    }

    const testUserIds = [testAdmin?.id, testStudent1?.id, testStudent2?.id].filter(Boolean);
    if (testUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: testUserIds } },
      });
    }

    const { disconnectRedis } = require('../src/integrations/redis/redisClient');
    await disconnectRedis().catch(() => {});
    await prisma.$disconnect();
    setTimeout(() => process.exit(0), 100);
  });

  it('1. Formats and normalizes codes properly', () => {
    assert.equal(accessCodeService.normalizeCode('a7x3-k9m2'), 'A7X3K9M2');
    assert.equal(accessCodeService.normalizeCode('  B4R6 K9M2  '), 'B4R6K9M2');
    assert.equal(accessCodeService.normalizeCode('a٧x٣-k٩m٢'), 'A7X3K9M2');
    assert.equal(accessCodeService.normalizeCode('A۷X۳K۹M۲'), 'A7X3K9M2');
    assert.equal(accessCodeService.formatCode('A7X3K9M2'), 'A7X3-K9M2');
    assert.equal(accessCodeService.formatCode('A7X3K9M2P4R6'), 'A7X3-K9M2-P4R6');
  });

  it('2. Rejects invalid batch generation parameters', async () => {
    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: 999999, quantity: 10, adminId: testAdmin.id }),
      (err) => err.code === 'COURSE_NOT_FOUND' && err.statusCode === 404
    );

    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: testCourse.id, quantity: 0, adminId: testAdmin.id }),
      (err) => err.code === 'INVALID_QUANTITY' && err.statusCode === 400
    );

    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: testCourse.id, quantity: 15000, adminId: testAdmin.id }),
      (err) => err.code === 'INVALID_QUANTITY' && err.statusCode === 400
    );

    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: testCourse.id, quantity: 10, codeLength: 7, adminId: testAdmin.id }),
      (err) => err.code === 'INVALID_CODE_LENGTH' && err.statusCode === 400
    );

    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: testCourse.id, quantity: 10, codeLength: 'invalid', adminId: testAdmin.id }),
      (err) => err.code === 'INVALID_CODE_LENGTH' && err.statusCode === 400
    );

    await assert.rejects(
      () => accessCodeService.generateBatch({ courseId: testCourse.id, quantity: 10, codeLength: 0, adminId: testAdmin.id }),
      (err) => err.code === 'INVALID_CODE_LENGTH' && err.statusCode === 400
    );
  });

  it('3. Generates a valid batch of codes with unambiguous characters', async () => {
    const batchData = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 5,
      codeLength: 8,
      label: 'سنتر النور - الدفعة 1',
      tags: ['cairo', 'physics'],
      adminId: testAdmin.id,
    });

    createdBatchIds.push(batchData.batchId);

    assert.ok(batchData.batchId > 0);
    assert.equal(batchData.courseId, testCourse.id);
    assert.equal(batchData.courseName, testCourse.title);
    assert.equal(batchData.quantity, 5);
    assert.equal(batchData.codeLength, 8);
    assert.equal(batchData.label, 'سنتر النور - الدفعة 1');
    assert.deepEqual(batchData.tags, ['cairo', 'physics']);
    assert.equal(batchData.codes.length, 5);

    // Verify all codes conform to 32-char alphabet and display format
    const AMBIGUOUS = /[01OIL]/;
    for (const code of batchData.codes) {
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.ok(!AMBIGUOUS.test(code), `Code ${code} contains ambiguous characters`);
    }

    // Verify DB count
    const countInDb = await prisma.accessCode.count({
      where: { batchId: batchData.batchId },
    });
    assert.equal(countInDb, 5);
  });

  it('4. Successfully redeems an available code and creates 365-day paid enrollment', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 3,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    const codeToRedeem = batch.codes[0]; // Formatted e.g. "A7X3-K9M2"

    // Redeem with lowercase and without dashes to test input normalization
    const normalizedInput = codeToRedeem.toLowerCase().replace('-', '');
    const result = await accessCodeService.redeemCode({
      userId: testStudent1.id,
      code: normalizedInput,
    });

    assert.equal(result.courseId, testCourse.id);
    assert.equal(result.courseName, testCourse.title);
    assert.equal(result.courseSlug, testCourse.slug);
    assert.ok(result.enrollmentId > 0);

    // Verify enrollment in DB
    const enrollment = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: testStudent1.id, courseId: testCourse.id } },
    });
    assert.ok(enrollment);
    assert.equal(enrollment.isPaid, true);
    assert.ok(enrollment.paymentDate);
    assert.ok(enrollment.expiresAt);

    // Verify 365 days window (~365 days from now)
    const expectedExpiryMin = Date.now() + 364 * 24 * 60 * 60 * 1000;
    assert.ok(enrollment.expiresAt.getTime() > expectedExpiryMin);

    // Verify code status changed to REDEEMED in DB
    const rawCanonical = accessCodeService.normalizeCode(codeToRedeem);
    const codeInDb = await prisma.accessCode.findUnique({
      where: { code: rawCanonical },
    });
    assert.equal(codeInDb.status, 'REDEEMED');
    assert.equal(codeInDb.redeemedBy, testStudent1.id);
    assert.ok(codeInDb.redeemedAt);
  });

  it('5. Rejects redemption of already redeemed code with 422 INVALID_CODE', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 1,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    const code = batch.codes[0];

    // First redemption by student 2
    await accessCodeService.redeemCode({
      userId: testStudent2.id,
      code,
    });

    // Second redemption attempt by student 1
    await assert.rejects(
      () => accessCodeService.redeemCode({ userId: testStudent1.id, code }),
      (err) => err.code === 'INVALID_CODE' && err.statusCode === 422
    );
  });

  it('6. Rejects redemption if student is already actively enrolled with 409 without consuming code', async () => {
    // testStudent1 is already enrolled from test 4
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 1,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    const freshCode = batch.codes[0];

    // Attempt redemption by already-enrolled student 1
    await assert.rejects(
      () => accessCodeService.redeemCode({ userId: testStudent1.id, code: freshCode }),
      (err) => err.code === 'ALREADY_ENROLLED' && err.statusCode === 409
    );

    // CRITICAL: Verify the fresh code remains AVAILABLE and was NOT consumed
    const codeRow = await prisma.accessCode.findUnique({
      where: { code: accessCodeService.normalizeCode(freshCode) },
    });
    assert.equal(codeRow.status, 'AVAILABLE');
    assert.equal(codeRow.redeemedBy, null);
  });

  it('7. Revokes individual code and whole batch', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 4,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    const codesInDb = await prisma.accessCode.findMany({
      where: { batchId: batch.batchId },
      orderBy: { id: 'asc' },
    });

    // 7.1 Revoke single code
    const singleRevoke = await accessCodeService.revokeCode({
      codeIds: [codesInDb[0].id],
      adminId: testAdmin.id,
    });
    assert.equal(singleRevoke.revokedCount, 1);

    const singleRow = await prisma.accessCode.findUnique({
      where: { id: codesInDb[0].id },
    });
    assert.equal(singleRow.status, 'REVOKED');
    assert.equal(singleRow.revokedBy, testAdmin.id);

    // Revoked code cannot be redeemed
    await assert.rejects(
      () => accessCodeService.redeemCode({ userId: testStudent2.id, code: singleRow.code }),
      (err) => err.code === 'INVALID_CODE' && err.statusCode === 422
    );

    // 7.2 Revoking missing ID rejected with 404
    await assert.rejects(
      () => accessCodeService.revokeCode({ codeIds: [codesInDb[0].id, 999999], adminId: testAdmin.id }),
      (err) => err.code === 'CODE_NOT_FOUND' && err.statusCode === 404
    );

    // 7.3 Revoke whole batch
    const batchRevoke = await accessCodeService.revokeBatch({
      batchId: batch.batchId,
      adminId: testAdmin.id,
    });
    // Remaining available codes were 3
    assert.equal(batchRevoke.revokedCount, 3);

    const remainingAvailable = await prisma.accessCode.count({
      where: { batchId: batch.batchId, status: 'AVAILABLE' },
    });
    assert.equal(remainingAvailable, 0);

    // 7.4 Verify getBatchDetails resolves revokedBy to user object { id, name, email }
    const details = await accessCodeService.getBatchDetails({
      batchId: batch.batchId,
      status: 'REVOKED',
    });
    assert.ok(details.codes.length > 0);
    assert.ok(details.codes[0].revokedBy && typeof details.codes[0].revokedBy === 'object');
    assert.equal(details.codes[0].revokedBy.id, testAdmin.id);
  });

  it('8. Cannot revoke an already redeemed code (409)', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 1,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    // Temporarily unenroll student 2 to allow redemption
    await prisma.enrollment.deleteMany({
      where: { userId: testStudent2.id, courseId: testCourse.id },
    });

    await accessCodeService.redeemCode({
      userId: testStudent2.id,
      code: batch.codes[0],
    });

    const redeemedRow = await prisma.accessCode.findUnique({
      where: { code: accessCodeService.normalizeCode(batch.codes[0]) },
    });

    await assert.rejects(
      () => accessCodeService.revokeCode({ codeIds: [redeemedRow.id], adminId: testAdmin.id }),
      (err) => err.code === 'CODE_ALREADY_REDEEMED' && err.statusCode === 409
    );
  });

  it('9. Lookups a code by value and returns full audit details', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 1,
      label: 'Batch for lookup test',
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);

    const lookupRes = await accessCodeService.lookupCode(batch.codes[0]);
    assert.equal(lookupRes.courseId, testCourse.id);
    assert.equal(lookupRes.status, 'AVAILABLE');
    assert.equal(lookupRes.batchLabel, 'Batch for lookup test');
    assert.equal(lookupRes.redeemedBy, null);
  });

  it('10. Lists batches and details with aggregated statistics', async () => {
    const batchesRes = await accessCodeService.getBatches({
      courseId: testCourse.id,
      page: 1,
      limit: 10,
    });

    assert.ok(batchesRes.batches.length > 0);
    assert.ok(batchesRes.pagination.total > 0);
    assert.ok(batchesRes.summaryStats);
    assert.ok(typeof batchesRes.summaryStats.available === 'number');

    const targetBatch = batchesRes.batches.find((b) => b.id === createdBatchIds[0]);
    assert.ok(targetBatch);
    assert.ok(typeof targetBatch.stats.available === 'number');

    const details = await accessCodeService.getBatchDetails({
      batchId: createdBatchIds[0],
      page: 1,
      limit: 10,
    });

    assert.equal(details.batch.id, createdBatchIds[0]);
    assert.equal(details.codes.length, 5);

    // Verify out-of-bounds page preserves real total and totalPages
    const outOfBounds = await accessCodeService.getBatches({
      courseId: testCourse.id,
      page: 9999,
      limit: 10,
    });
    assert.equal(outOfBounds.batches.length, 0);
    assert.ok(outOfBounds.pagination.total > 0);
    assert.ok(outOfBounds.pagination.totalPages > 0);

    // Verify empty batch filter returns totalPages: 0
    const emptyDetails = await accessCodeService.getBatchDetails({
      batchId: createdBatchIds[0],
      status: 'REDEEMED',
    });
    if (emptyDetails.pagination.total === 0) {
      assert.equal(emptyDetails.pagination.totalPages, 0);
    }
  });

  it('11. Generates downloadable CSV with proper UTF-8 headers and formula sanitization', async () => {
    const regularBatch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 2,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(regularBatch.batchId);
    const { filename, csvContent } = await accessCodeService.getBatchCsv(regularBatch.batchId);
    assert.ok(filename.endsWith('.csv'));
    assert.ok(csvContent.startsWith('\uFEFFcode,status,courseId,courseName,redeemedBy,redeemedAt'));
    assert.ok(csvContent.includes(testCourse.title));

    // Verify CSV formula injection prevention (CWE-1236)
    const formulaCourse = await prisma.course.create({
      data: {
        title: '=1+2 Formula Test',
        slug: randomBase36Slug(),
        description: 'formula test',
        price: 100,
        thumbnail: 'https://example.com/thumb.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: testAdmin.id,
      },
    });
    createdCourseIds.push(formulaCourse.id);
    const formulaBatch = await accessCodeService.generateBatch({
      courseId: formulaCourse.id,
      quantity: 1,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(formulaBatch.batchId);
    const { csvContent: formulaCsv } = await accessCodeService.getBatchCsv(formulaBatch.batchId);
    assert.ok(formulaCsv.includes("'="), 'CSV formula prefix must be neutralized with a leading single quote');
  });

  it('12. Prevents double-redemption race conditions under concurrent execution', async () => {
    const batch = await accessCodeService.generateBatch({
      courseId: testCourse.id,
      quantity: 1,
      adminId: testAdmin.id,
    });
    createdBatchIds.push(batch.batchId);
    const code = batch.codes[0];

    const student3 = await prisma.user.create({
      data: {
        name: 'Test Student 3 AC',
        email: `student3.ac.${Date.now()}@test.local`,
        password: 'Password123!',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
        slug: randomBase36Slug(),
      },
    });

    const student4 = await prisma.user.create({
      data: {
        name: 'Test Student 4 AC',
        email: `student4.ac.${Date.now()}@test.local`,
        password: 'Password123!',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
        slug: randomBase36Slug(),
      },
    });

    try {
      const results = await Promise.allSettled([
        accessCodeService.redeemCode({ userId: student3.id, code }),
        accessCodeService.redeemCode({ userId: student4.id, code }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one concurrent redemption must succeed');
      assert.equal(rejected.length, 1, 'Exactly one concurrent redemption must be rejected');
      assert.equal(rejected[0].reason.code, 'INVALID_CODE');
      assert.equal(rejected[0].reason.statusCode, 422);
    } finally {
      await prisma.enrollment.deleteMany({
        where: { userId: { in: [student3.id, student4.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [student3.id, student4.id] } },
      });
    }
  });

  it('13. HTTP routes enforce authentication, role gating, and rate limiting end-to-end', async () => {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const accessCodeRoutes = require('../src/routes/accessCodeRoutes');

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/access-codes', accessCodeRoutes);

    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const adminToken = createToken(
      { id: testAdmin.id, email: testAdmin.email, name: testAdmin.name, role: 'ADMIN' },
      config.jwt.secret
    );
    const studentToken = createToken(
      { id: testStudent1.id, email: testStudent1.email, name: testStudent1.name, role: 'STUDENT' },
      config.jwt.secret
    );

    try {
      const headersClose = { Connection: 'close' };

      // 13.1 Student trying to generate batch -> 403 Forbidden
      const unauthAdmin = await fetch(`${baseUrl}/access-codes/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}`, ...headersClose },
        body: JSON.stringify({ courseId: testCourse.id, quantity: 1 }),
      });
      assert.equal(unauthAdmin.status, 403);

      // 13.2 Unauthenticated student redemption -> 401 Unauthorized
      const noAuthRedeem = await fetch(`${baseUrl}/access-codes/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersClose },
        body: JSON.stringify({ code: 'A7X3-K9M2' }),
      });
      assert.equal(noAuthRedeem.status, 401);

      // 13.3 Admin generating batch -> 201 Created
      const genRes = await fetch(`${baseUrl}/access-codes/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, ...headersClose },
        body: JSON.stringify({ courseId: testCourse.id, quantity: 2, label: 'HTTP Batch Test' }),
      });
      assert.equal(genRes.status, 201);
      const genJson = await genRes.json();
      assert.equal(genJson.success, true);
      assert.equal(genJson.data.quantity, 2);
      createdBatchIds.push(genJson.data.batchId);
      const httpCode = genJson.data.codes[0];

      // 13.4 Admin listing batches -> 200 OK
      const listRes = await fetch(`${baseUrl}/access-codes/batches`, {
        headers: { Authorization: `Bearer ${adminToken}`, ...headersClose },
      });
      assert.equal(listRes.status, 200);
      const listJson = await listRes.json();
      assert.equal(listJson.success, true);
      assert.ok(Array.isArray(listJson.data.batches));

      // 13.5 Admin CSV download -> 200 OK with proper text/csv headers
      const downloadRes = await fetch(`${baseUrl}/access-codes/batches/${genJson.data.batchId}/download`, {
        headers: { Authorization: `Bearer ${adminToken}`, ...headersClose },
      });
      assert.equal(downloadRes.status, 200);
      assert.ok(downloadRes.headers.get('content-type').includes('text/csv'));
      assert.ok(downloadRes.headers.get('content-disposition').includes('attachment'));
      const csvText = await downloadRes.text();
      assert.ok(csvText.includes(testCourse.title));

      // 13.6 Admin code lookup -> 200 OK
      const lookupRes = await fetch(`${baseUrl}/access-codes/lookup/${httpCode}`, {
        headers: { Authorization: `Bearer ${adminToken}`, ...headersClose },
      });
      assert.equal(lookupRes.status, 200);
      const lookupJson = await lookupRes.json();
      assert.equal(lookupJson.data.status, 'AVAILABLE');

      // 13.7 Rate limit test on redemption:
      // A student attempting 5 invalid redemptions hits 429 on 6th attempt
      for (let i = 0; i < 5; i++) {
        const attempt = await fetch(`${baseUrl}/access-codes/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}`, ...headersClose },
          body: JSON.stringify({ code: `INVALID${i}X` }),
        });
        assert.ok([400, 422].includes(attempt.status), `Attempt ${i + 1} status was ${attempt.status}`);
      }

      // 6th attempt MUST be 429 RATE_LIMITED
      const throttled = await fetch(`${baseUrl}/access-codes/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}`, ...headersClose },
        body: JSON.stringify({ code: 'INVALID6X' }),
      });
      assert.equal(throttled.status, 429);
      const throttledJson = await throttled.json();
      assert.equal(throttledJson.code, 'RATE_LIMITED');
      assert.equal(throttledJson.error, 'حاولت مرات كثيرة. حاول مرة أخرى بعد قليل');
    } finally {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
