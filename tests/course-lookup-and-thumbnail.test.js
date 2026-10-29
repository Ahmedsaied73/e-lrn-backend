'use strict';

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
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'Admin', role: 'ADMIN' }, config.jwt.secret)}`;

describe('Course Lookup (Slug and Numeric ID) & Thumbnail Delivery', () => {
  let createdCourse = null;

  before(async () => {
    // Create a course with a custom thumbnail image URL via POST /courses
    const createRes = await fetch(`${API}/courses`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `Thumbnail Test Course ${Date.now()}`,
        description: 'Testing thumbnail appearance on course cards and detail page',
        price: 150,
        grade: 'FIRST_SECONDARY',
        thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3',
      }),
    });
    const body = await createRes.json();
    assert.equal(createRes.status, 201);
    const dbCourse = await prisma.course.findUnique({ where: { slug: body.data.slug } });
    createdCourse = dbCourse;
  });

  after(async () => {
    if (createdCourse) {
      try {
        await prisma.course.delete({ where: { id: createdCourse.id } });
      } catch {
        // ignore
      }
    }
    await prisma.$disconnect();
  });

  it('delivers thumbnail in GET /courses list', async () => {
    const res = await fetch(`${API}/courses?limit=100`, {
      headers: { Cookie: adminCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const found = body.data.find((c) => c.slug === createdCourse.slug);
    assert.ok(found, 'Created course should be in course list');
    assert.equal(found.thumbnail, createdCourse.thumbnail);
  });

  it('delivers thumbnail and course details via slug: GET /courses/:slug', async () => {
    const res = await fetch(`${API}/courses/${createdCourse.slug}`, {
      headers: { Cookie: adminCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.course);
    assert.equal(body.data.course.slug, createdCourse.slug);
    assert.equal(body.data.course.thumbnail, createdCourse.thumbnail);
  });

  it('delivers thumbnail and course details via numeric ID fallback: GET /courses/:id', async () => {
    const res = await fetch(`${API}/courses/${createdCourse.id}`, {
      headers: { Cookie: adminCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.course);
    assert.equal(body.data.course.slug, createdCourse.slug);
    assert.equal(body.data.course.thumbnail, createdCourse.thumbnail);
  });

  it('supports numeric ID fallback in GET /courses/:id/bunny-videos', async () => {
    const res = await fetch(`${API}/courses/${createdCourse.id}/bunny-videos`, {
      headers: { Cookie: adminCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));
  });

  it('rejects completely invalid course identifier with 400', async () => {
    const res = await fetch(`${API}/courses/invalid_slug!@#`, {
      headers: { Cookie: adminCookie() },
    });
    assert.equal(res.status, 400);
  });

  it('delivers course thumbnail and list to unauthenticated visitors (no cookie)', async () => {
    const res = await fetch(`${API}/courses?limit=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const found = body.data.find((c) => c.slug === createdCourse.slug);
    assert.ok(found, 'Created course should be visible to unauthenticated visitors');
    assert.equal(found.thumbnail, createdCourse.thumbnail);
  });

  it('delivers course details and thumbnail to unauthenticated visitors via slug and numeric ID', async () => {
    const [resSlug, resId, resVideos] = await Promise.all([
      fetch(`${API}/courses/${createdCourse.slug}`),
      fetch(`${API}/courses/${createdCourse.id}`),
      fetch(`${API}/courses/${createdCourse.slug}/bunny-videos`),
    ]);

    assert.equal(resSlug.status, 200);
    const bodySlug = await resSlug.json();
    assert.equal(bodySlug.success, true);
    assert.equal(bodySlug.data.course.thumbnail, createdCourse.thumbnail);
    assert.equal(bodySlug.data.enrollment, null);

    assert.equal(resId.status, 200);
    const bodyId = await resId.json();
    assert.equal(bodyId.success, true);
    assert.equal(bodyId.data.course.thumbnail, createdCourse.thumbnail);

    assert.equal(resVideos.status, 200);
    const bodyVideos = await resVideos.json();
    assert.equal(bodyVideos.success, true);
    assert.ok(Array.isArray(bodyVideos.data));
  });
});
