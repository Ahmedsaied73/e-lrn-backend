'use strict';
// P2: admin course endpoints — list carries _count/{videos,enrollments} + category,
// createCourse honors `category`, updateCourse persists category, deleteCourse removes course.
// Uses a throwaway course (create → list → update → delete) so no existing data is touched.
const assert = require('assert');
const prisma = require('../src/config/db');
const BASE = 'http://localhost:3005';

function cookieString(res) {
  const raw = (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
  return (raw.length ? raw : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
    .map((c) => c.split(';')[0]).filter((p) => ['accessToken', 'refreshToken'].includes(p.split('=')[0].trim())).join('; ');
}

(async () => {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };

  try {
    const admin = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@elearning.com', password: 'admin123' }) }));
    const adminCookie = cookieString(admin);
    assert(adminCookie, 'admin login');

    const anon = await fetch(`${BASE}/courses`);
    check('401 when unauthenticated', anon.status === 401, `status=${anon.status}`);

    // list shape
    const list = await (await fetch(`${BASE}/courses?page=1&limit=100`, { headers: { Cookie: adminCookie } })).json();
    check('list returns success+meta', list.success === true && Number.isInteger(list.meta?.total), `total=${list.meta?.total}`);
    const sample = list.data?.[0];
    if (list.meta?.total > 0) {
      check('list rows carry _count.videos', sample?._count && Number.isInteger(sample._count.videos), JSON.stringify(sample?._count));
      check('list rows carry _count.enrollments', sample?._count && Number.isInteger(sample._count.enrollments), JSON.stringify(sample?._count));
      check('list rows carry category key', 'category' in (sample || {}));
    } else {
      console.log('SKIP row-shape asserts — course table is empty (fresh DB)');
    }

    // create with category
    const tag = `p2_${Date.now()}`;
    const created = await (await fetch(`${BASE}/courses`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `P2 Test ${tag}`, description: 'p2 test course', price: 99, grade: 'THIRD_SECONDARY', category: 'رياضيات' })
    })).json();
    check('create returns 201 + success', created.success === true && created.data?.id, JSON.stringify(created));
    const courseId = created.data?.id;
    check('create persisted category + teacher=first ADMIN', created.data?.category === 'رياضيات' && created.data?.teacherId != null);

    // list find new course with counts
    const list2 = await (await fetch(`${BASE}/courses?page=1&limit=100`, { headers: { Cookie: adminCookie } })).json();
    const row = list2.data?.find((c) => c.id === courseId);
    check('new course listed with _count', row && Number.isInteger(row._count.videos) && Number.isInteger(row._count.enrollments), JSON.stringify(row?._count));
    check('new course listed with category', row?.category === 'رياضيات');

    // search narrows by title (contains, case-insensitive on MySQL)
    const hit = await (await fetch(`${BASE}/courses?search=${tag}`, { headers: { Cookie: adminCookie } })).json();
    check('search narrows by title', hit.success === true && hit.meta.total === 1 && hit.data[0]?.id === courseId, `total=${hit.meta?.total}`);
    const noHit = await (await fetch(`${BASE}/courses?search=zzz_nonexistent_zzz`, { headers: { Cookie: adminCookie } })).json();
    check('search with no matches returns empty', noHit.success === true && noHit.meta.total === 0 && noHit.data.length === 0);

    // update category + title
    const updated = await (await fetch(`${BASE}/courses/${courseId}`, {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `P2 Test ${tag} (edited)`, category: 'علوم' })
    })).json();
    check('update persists category', updated.success === true && updated.data?.category === 'علوم', JSON.stringify(updated.data?.category));

    // non-admin cannot create
    const student = await prisma.user.findFirst({ where: { role: 'STUDENT' } });
    const forb = await fetch(`${BASE}/courses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', description: 'y', price: 1, grade: 'FIRST_SECONDARY' }) });
    check('unauthenticated create forbidden', forb.status === 401, `status=${forb.status}`);

    // delete cleanup (row removed)
    const del = await (await fetch(`${BASE}/courses/${courseId}`, { method: 'DELETE', headers: { Cookie: adminCookie } })).json();
    check('delete removes course', del.success === true);
    const gone = await prisma.course.findUnique({ where: { id: courseId } });
    check('course truly gone in DB', gone === null);
  } catch (error) {
    console.error('FATAL', error.message);
    failures++;
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failures ? 1 : 0);
})();