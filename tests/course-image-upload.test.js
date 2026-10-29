'use strict';
/**
 * Test course image upload endpoint (POST /courses/images).
 * Runs with node:test against the running backend server.
 */
process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { randomBase36Slug } = require('../src/utils/slugs.js');
const { PrismaClient } = require('@prisma/client');

const API = process.env.TEST_BASE_URL || 'http://localhost:3005';
const prisma = new PrismaClient();

const adminCookie = () =>
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' }, config.jwt.secret)}`;

describe('POST /courses/images', () => {
  let student = null;
  let testCourseSlug = null;

  before(async () => {
    const email = `courseimg-${Date.now()}@localhost.test`;
    const user = await prisma.user.create({
      data: { slug: randomBase36Slug(), name: 'Student', email, password: 'x', grade: 'FIRST_SECONDARY' },
    });
    student = {
      user,
      cookie: `accessToken=${createToken({ id: user.id, email, name: 'S', role: 'STUDENT' }, config.jwt.secret)}`,
    };
  });

  after(async () => {
    if (testCourseSlug) {
      try {
        await prisma.course.delete({ where: { slug: testCourseSlug } });
      } catch {
        // ignore
      }
    }
    if (student) {
      await prisma.user.delete({ where: { id: student.user.id } });
    }
    await prisma.$disconnect();
  });

  it('rejects unauthenticated request with 401', async () => {
    const res = await fetch(`${API}/courses/images`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('rejects student callers with 403', async () => {
    const res = await fetch(`${API}/courses/images`, {
      method: 'POST',
      headers: { Cookie: student.cookie },
    });
    assert.equal(res.status, 403);
  });

  it('rejects invalid image mime type with 415', async () => {
    const boundary = '----WebKitFormBoundaryTest123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="image"; filename="test.txt"',
      'Content-Type: text/plain',
      '',
      'plain text file',
      `--${boundary}--`,
    ].join('\r\n');

    const res = await fetch(`${API}/courses/images`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(res.status, 415);
  });

  it('uploads a valid PNG image and returns the public url', async () => {
    // 1x1 transparent PNG bytes
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const boundary = '----WebKitFormBoundaryTest456';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="thumb.png"\r\nContent-Type: image/png\r\n\r\n`),
      pngBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${API}/courses/images`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.data.url);
    assert.ok(data.data.url.startsWith('https://') || data.data.url.startsWith('http://'));

    // Now test creating a course with this thumbnail
    const createRes = await fetch(`${API}/courses`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Test Course With Image ${Date.now()}`,
        description: 'Test course description',
        price: 50,
        grade: 'FIRST_SECONDARY',
        thumbnail: data.data.url,
      }),
    });

    assert.equal(createRes.status, 201);
    const courseData = await createRes.json();
    testCourseSlug = courseData.data.slug;
    assert.equal(courseData.data.thumbnail, data.data.url);

    // Test updating course with a different thumbnail URL
    const updateRes = await fetch(`${API}/courses/${testCourseSlug}`, {
      method: 'PUT',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        thumbnail: 'https://example.com/new-photo.jpg',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.equal(updateData.data.thumbnail, 'https://example.com/new-photo.jpg');

    // Test clearing thumbnail (setting to empty string)
    const clearRes = await fetch(`${API}/courses/${testCourseSlug}`, {
      method: 'PUT',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        thumbnail: '',
      }),
    });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.data.thumbnail, 'https://via.placeholder.com/640x360?text=No+Thumbnail');
  });

  it('uploads a valid WebP image and returns the public url', async () => {
    // 1x1 valid WebP bytes
    const webpBuffer = Buffer.from(
      'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=',
      'base64'
    );
    const boundary = '----WebKitFormBoundaryWebpTest789';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.webp"\r\nContent-Type: image/webp\r\n\r\n`),
      webpBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${API}/courses/images`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.data.url);
    assert.ok(data.data.url.endsWith('.webp'));
  });
});
