'use strict';
// P3 (T3.1): admin quizzes index + global attempts endpoints.
// GET /admin/quizzes  — searchable, paginated, attempt counts, NO answerKey.
// GET /admin/attempts — ?status= filter, searchable, student+quiz context, NO answers leak.
// Uses a throwaway quiz + throwaway student, cleaned up via admin DELETE endpoints.
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

  let admin, course, v1, studentUser = null, quizId = null;
  try {
    admin = await login('admin@elearning.com', 'admin123');
    assert(admin.cookie, 'admin login');

    // Auth guards
    const anonQ = await fetch(`${BASE}/admin/quizzes`);
    check('admin/quizzes 401 unauthenticated', anonQ.status === 401, `status=${anonQ.status}`);
    const anonA = await fetch(`${BASE}/admin/attempts`);
    check('admin/attempts 401 unauthenticated', anonA.status === 401, `status=${anonA.status}`);

    // Find a video on the demo course to host a throwaway quiz
    course = await prisma.course.findFirst({ where: { title: 'Sequential Access Test Course' } });
    assert(course, 'demo course exists (run uploadDemoVideos.js if missing)');
    v1 = await prisma.bunnyVideo.findFirst({ where: { courseId: course.id }, orderBy: { position: 'asc' } });
    assert(v1, 'demo course has a video');

    // Empty-ish list shape (may still contain legacy quizzes)
    const list0 = await (await fetch(`${BASE}/admin/quizzes?page=1&limit=20`, { headers: { Cookie: admin.cookie } })).json();
    check('quizzes index returns success+meta', list0.success === true && Number.isInteger(list0.meta?.total), `total=${list0.meta?.total}`);
    const leak0 = JSON.stringify(list0);
    check('quizzes index never leaks answerKey', !leak0.includes('answerKey'));

    // Create a temp quiz WITH an essay question (=> GRADING-capable)
    const tag = `t31_${Date.now()}`;
    const created = await (await fetch(`${BASE}/quizzes/videos/${v1.id}`, {
      method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `T31 ${tag}`, passingScore: 60, timeLimitSec: null, maxAttempts: 3,
        surveyJson: { pages: [{ elements: [
          { type: 'radiogroup', name: 'q1', title: '2 + 2?', choices: ['3', '4', '5'] },
          { type: 'comment', name: 'essay1', title: 'Explain' },
        ] }] },
        answerKey: { q1: { type: 'radiogroup', correctValue: '4', points: 50 }, essay1: { type: 'comment', modelAnswer: 'because', points: 50 } },
      })
    })).json();
    check('temp quiz created', created.success === true && created.data?.id, JSON.stringify(created.data?.id));
    quizId = created.data?.id;

    // Searchable + counts
    const hits = await (await fetch(`${BASE}/admin/quizzes?search=${tag}`, { headers: { Cookie: admin.cookie } })).json();
    check('quizzes search narrows to 1', hits.success === true && hits.meta.total === 1 && hits.data[0]?.id === quizId, `total=${hits.meta?.total}`);
    const row = hits.data?.[0];
    check('row has video/course context', row?.videoTitle && row?.courseTitle, JSON.stringify(row?.videoTitle));
    check('row has attempt counts', Number.isInteger(row?.totalAttempts) && Number.isInteger(row?.pendingGrading), `totalAttempts=${row?.totalAttempts} pending=${row?.pendingGrading}`);

    // Non-admin forbidden
    const stuEmail = `t31-${tag}@localhost.test`;
    const reg = await (await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'T31 Student', email: stuEmail, password: 'T31#PASS', phoneNumber: '01199900001', grade: 'THIRD_SECONDARY' }) })).json();
    check('temp student registered', reg.success === true && reg.data?.user?.id, JSON.stringify(reg.data?.user?.id));
    studentUser = await prisma.user.findUnique({ where: { email: stuEmail } });
    const stuLogin = await login(stuEmail, 'T31#PASS');
    const forb = await fetch(`${BASE}/admin/attempts`, { headers: { Cookie: stuLogin.cookie } });
    check('admin/attempts 403 for student', forb.status === 403, `status=${forb.status}`);

    // Student: enroll → complete v1 → start → submit (essay => GRADING)
    await prisma.enrollment.create({ data: { userId: studentUser.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
    const comp = await fetch(`${BASE}/progress/complete`, { method: 'POST', headers: { Cookie: stuLogin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: v1.id }) });
    check('v1 marked complete', comp.status === 200, `status=${comp.status} ${await comp.text()}`);
    const startRes = await (await fetch(`${BASE}/quizzes/videos/${v1.id}/start`, { method: 'POST', headers: { Cookie: stuLogin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
    const attemptId = startRes?.data?.attemptId;
    check('quiz started', Number.isInteger(attemptId), JSON.stringify(startRes));
    const subRes = await (await fetch(`${BASE}/quizzes/attempts/${attemptId}/submit`, { method: 'POST', headers: { Cookie: stuLogin.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { q1: '4', essay1: 'my explanation' } }) })).json();
    check('essay submit → GRADING', subRes.success === true && subRes.data?.status === 'GRADING', JSON.stringify(subRes.data?.status));

    // Global attempts list
    const atts = await (await fetch(`${BASE}/admin/attempts?status=GRADING&search=${tag}`, { headers: { Cookie: admin.cookie } })).json();
    check('attempts.status filter + search returns 1', atts.success === true && atts.meta.total === 1, `total=${atts.meta?.total}`);
    const a = atts.data?.[0];
    check('attempt row has student + quiz + score context', a?.student?.name === 'T31 Student' && a?.videoTitle && a?.quizTitle === `T31 ${tag}`, JSON.stringify({ s: a?.student?.name, v: a?.videoTitle }));
    const raw = JSON.stringify(atts);
    check('attempts payload leaks no responses/answerKey', !raw.includes('"responses"') && !raw.includes('answerKey'));
    const allAtts = await (await fetch(`${BASE}/admin/attempts?search=${tag}`, { headers: { Cookie: admin.cookie } })).json();
    check('attempts unfiltered also lists it', allAtts.success === true && allAtts.data.some((x) => x.id === a.id));
    check('attempt meta is consistent', Number.isInteger(allAtts.meta.total) && Number.isInteger(allAtts.meta.totalPages));

    // Cleanup: quiz delete cascades attempts; user delete cascades enrollment/progress/attempts
    const delQ = await (await fetch(`${BASE}/quizzes/${quizId}`, { method: 'DELETE', headers: { Cookie: admin.cookie } })).json();
    check('quiz deleted', delQ.success === true);
    quizId = null;
    const quizGone = await prisma.quiz.findUnique({ where: { id: created.data.id } });
    check('quiz truly gone (attempts cascaded)', quizGone === null);
    const delU = await (await fetch(`${BASE}/user/${studentUser.id}`, { method: 'DELETE', headers: { Cookie: admin.cookie } })).json();
    check('temp student deleted', delU.success === true);
    studentUser = null;
  } catch (error) {
    console.error('FATAL', error.message);
    failures++;
  } finally {
    // Best-effort cleanup if something failed mid-test
    try {
      if (studentUser) {
        await fetch(`${BASE}/user/${studentUser.id}`, { method: 'DELETE', headers: { Cookie: admin?.cookie || '' } });
        await prisma.user.deleteMany({ where: { email: { startsWith: 't31-' } } });
      }
      if (quizId) await prisma.quiz.deleteMany({ where: { id: quizId } });
    } catch (e) { console.error('cleanup err', e.message); }
    await prisma.$disconnect();
  }
  process.exit(failures ? 1 : 0);
})();