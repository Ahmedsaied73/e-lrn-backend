'use strict';
// P3 (T3.2): admin enrollment endpoints + admin user-edit extension.
// GET /admin/enrollments — filters + student/course context, no secrets.
// POST /admin/enrollments — admin enrolls any student (auto-paid, dup → 409).
// DELETE /admin/enrollments/:id — unenroll, FK-safe.
// PUT /user/:id (ADMIN) — may also set grade + phoneNumber; self-edit unchanged.
const assert = require('assert');
const prisma = require('../src/config/db');
const BASE = 'http://localhost:3005';

function cookieString(res) {
  const raw = (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
  return (raw.length ? raw : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : [])
    .map((c) => c.split(';')[0]).filter((p) => ['accessToken', 'refreshToken'].includes(p.split('=')[0].trim())).join('; ');
}

async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, cookie: cookieString(res) };
}

(async () => {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };

  let admin, course, stuUser = null, enrollmentId = null;
  const tag = `t32_${Date.now()}`;
  try {
    admin = await login('admin@elearning.com', 'admin123');
    assert(admin.cookie, 'admin login');

    const anon = await fetch(`${BASE}/admin/enrollments`);
    check('admin/enrollments 401 unauthenticated', anon.status === 401, `status=${anon.status}`);

    course = await prisma.course.findFirst({ where: { title: 'Sequential Access Test Course' } });
    assert(course, 'demo course exists');

    // Temp student
    const email = `t32-${tag}@localhost.test`;
    const reg = await (await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'T32 Student', email, password: 'T32#PASS', phoneNumber: '01199900042', grade: 'SECOND_SECONDARY' }) })).json();
    check('temp student registered', reg.success === true && reg.data?.user?.id);
    stuUser = await prisma.user.findUnique({ where: { email } });
    const stuLogin = await login(email, 'T32#PASS');

    // Student blocked from admin enroll endpoints
    const forbList = await fetch(`${BASE}/admin/enrollments`, { headers: { Cookie: stuLogin.cookie } });
    check('student 403 on admin/enrollments', forbList.status === 403, `status=${forbList.status}`);

    // Admin enrolls student
    const enrollRes = await (await fetch(`${BASE}/admin/enrollments`, {
      method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: stuUser.id, courseId: course.id })
    })).json();
    check('admin enroll creates enrollment', enrollRes.success === true && enrollRes.data?.enrollment?.id, JSON.stringify(enrollRes.data?.enrollment?.id));
    enrollmentId = enrollRes.data?.enrollment?.id;
    const en = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    check('enrollment is auto-paid + paymentDate', en?.isPaid === true && en?.paymentDate instanceof Date);

    // Duplicate → 409
    const dup = await (await fetch(`${BASE}/admin/enrollments`, {
      method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: stuUser.id, courseId: course.id })
    }));
    check('duplicate enroll → 409', dup.status === 409, `status=${dup.status}`);

    // Bad refs
    const badUser = await (await fetch(`${BASE}/admin/enrollments`, {
      method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 999999, courseId: course.id })
    }));
    check('enroll unknown user → 404', badUser.status === 404, `status=${badUser.status}`);

    // List + filters
    const list = await (await fetch(`${BASE}/admin/enrollments?isPaid=true&search=${tag}`, { headers: { Cookie: admin.cookie } })).json();
    check('list filters to the new enrollment', list.success === true && list.data.some((e) => e.id === enrollmentId), `total=${list.meta?.total}`);
    const row = list.data.find((e) => e.id === enrollmentId);
    check('row has student + course context', row?.student?.name === 'T32 Student' && row?.course?.title === course.title, JSON.stringify(row?.course?.title));
    check('list payload has no secrets', !JSON.stringify(list).includes('"password"') && !JSON.stringify(list).includes('refreshToken'));

    const byUser = await (await fetch(`${BASE}/admin/enrollments?userId=${stuUser.id}`, { headers: { Cookie: admin.cookie } })).json();
    check('userId filter works', byUser.success === true && byUser.meta.total === 1);

    // Admin edits grade + phoneNumber
    const upd = await (await fetch(`${BASE}/user/${stuUser.id}`, {
      method: 'PUT', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T32 Student Updated', grade: 'THIRD_SECONDARY', phoneNumber: '01199900099' })
    })).json();
    check('admin updates name/grade/phone', upd.success === true && upd.data?.grade === 'THIRD_SECONDARY' && upd.data?.phoneNumber === '01199900099' && upd.data?.name === 'T32 Student Updated', JSON.stringify({ g: upd.data?.grade, p: upd.data?.phoneNumber }));

    // Student self-edit cannot change grade/phone
    const selfUpd = await (await fetch(`${BASE}/user/${stuUser.id}`, {
      method: 'PUT', headers: { Cookie: stuLogin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade: 'FIRST_SECONDARY', phoneNumber: '01100000000', name: 'T32 Self' })
    })).json();
    const afterSelf = await prisma.user.findUnique({ where: { id: stuUser.id } });
    check('self-edit name works, grade/phone unchanged', selfUpd.success === true && afterSelf?.name === 'T32 Self' && afterSelf?.grade === 'THIRD_SECONDARY' && afterSelf?.phoneNumber === '01199900099', JSON.stringify({ g: afterSelf?.grade, p: afterSelf?.phoneNumber }));

    // Unenroll
    const del = await (await fetch(`${BASE}/admin/enrollments/${enrollmentId}`, { method: 'DELETE', headers: { Cookie: admin.cookie } })).json();
    check('unenroll succeeds', del.success === true);
    const gone = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    check('enrollment truly gone', gone === null);
    enrollmentId = null;
    const listAfter = await (await fetch(`${BASE}/admin/enrollments?userId=${stuUser.id}`, { headers: { Cookie: admin.cookie } })).json();
    check('user no longer enrolled', listAfter.meta.total === 0, `total=${listAfter.meta?.total}`);
  } catch (error) {
    console.error('FATAL', error.message);
    failures++;
  } finally {
    try {
      if (enrollmentId) await prisma.enrollment.deleteMany({ where: { id: enrollmentId } });
      if (stuUser) await prisma.user.deleteMany({ where: { id: stuUser.id } });
    } catch (e) { console.error('cleanup err', e.message); }
    await prisma.$disconnect();
  }
  process.exit(failures ? 1 : 0);
})();