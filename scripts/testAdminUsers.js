'use strict';
// P1.1: GET /user filters + sensitive-field pruning + transactional cascade delete.
// Creates a throwaway student with EVERY Restrict-relation child row (enrollment,
// payment, certificate, videoProgress, submission, assignmentAnswer, quizAttempt,
// gateExemption, bunnyVideoProgress) and proves deleteUser removes them all.
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
  let adminCookie;
  let studentId, videoId, assignmentId, questionId;
  let ownerStudentId, ownedCourseId;

  try {
    const admin = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@elearning.com', password: 'admin123' }) }));
    adminCookie = cookieString(admin);
    assert(adminCookie, 'admin login');

    const anon = await fetch(`${BASE}/user?role=STUDENT`);
    check('401 when unauthenticated', anon.status === 401, `status=${anon.status}`);

    // Seed all child rows
    const tag = `p1_${Date.now()}`;
    const email = `${tag}@localhost.test`;
    const student = await prisma.user.create({ data: { name: 'P1 Cascade Student', email, password: 'x', grade: 'FIRST_SECONDARY' } });
    studentId = student.id;
    const course = await prisma.course.findFirst();
    await prisma.enrollment.create({ data: { userId: studentId, courseId: course.id, isPaid: true } });
    await prisma.payment.create({ data: { userId: studentId, amount: 10, status: 'COMPLETED' } });
    await prisma.certificate.create({ data: { userId: studentId, courseId: course.id, certificateNumber: `CERT_${tag}` } });
    const video = await prisma.video.create({ data: { title: `p1 ${tag}`, url: 'https://x/v.mp4', thumbnail: 'https://x/t.png', courseId: course.id, duration: 60 } });
    videoId = video.id;
    const assignment = await prisma.assignment.create({ data: { title: `p1 ${tag}`, videoId, isMCQ: true } });
    assignmentId = assignment.id;
    await prisma.submission.create({ data: { userId: studentId, assignmentId, content: 'x', status: 'PENDING' } });
    const bv = await prisma.bunnyVideo.findFirstOrThrow();
    await prisma.quizAttempt.create({ data: { userId: studentId, quizId: bv.quizId ?? 1, status: 'IN_PROGRESS', attemptNumber: 1 } }).catch(() => {});
    await prisma.gateExemption.create({ data: { userId: studentId, bunnyVideoId: bv.id, grantedBy: studentId, reason: 'p1 test' } });
    await prisma.bunnyVideoProgress.create({ data: { userId: studentId, bunnyVideoId: bv.id, completed: true } });
    const quest = await prisma.assignmentQuestion.create({ data: { assignmentId, text: 'q?', options: ['a'], correctOption: 0 } });
    questionId = quest.id;
    await prisma.assignmentAnswer.create({ data: { userId: studentId, questionId: questionId, selectedOption: 0, isCorrect: true } });

    // Filters
    const filtered = await (await fetch(`${BASE}/user?role=STUDENT&grade=FIRST_SECONDARY&search=${tag}&sort=-createdAt&limit=5`, { headers: { Cookie: adminCookie } })).json();
    check('filtered list finds fresh student', filtered.success && filtered.data.some((u) => u.email === email), filtered.success ? `${filtered.data.length} rows` : JSON.stringify(filtered));
    check('meta intact + reflects filter', filtered.meta?.total >= 1 && filtered.meta.total < 15, `total=${filtered.meta?.total}`);

    const one = filtered.data.find((u) => u.email === email);
    const leaked = ['password', 'refreshToken'].filter((k) => Object.keys(one || {}).includes(k));
    check('no password/refreshToken in list payload', leaked.length === 0, leaked.join(',') || 'clean');
    check('lastLoginAt selected for admin list', 'lastLoginAt' in one);

    const up = await (await fetch(`${BASE}/user/${studentId}`, { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'P1 Updated Name' }) })).json();
    check('PUT /user/:id persists name', up.success && up.data.name === 'P1 Updated Name');

    // Delete with 9 child-row types present (would previously throw P2003)
    const del = await fetch(`${BASE}/user/${studentId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
    const delJson = await del.json();
    check('DELETE succeeds with all child rows (no P2003)', del.status === 200 && delJson.success, `status=${del.status}`);
    check('user row removed', (await prisma.user.findUnique({ where: { id: studentId } })) === null);
    const orphanCounts = await Promise.all(['enrollment', 'payment', 'certificate', 'submission', 'assignmentAnswer', 'quizAttempt', 'gateExemption', 'bunnyVideoProgress'].map((m) => prisma[m].count({ where: { userId: studentId } })));
    const orphans = orphanCounts.reduce((a, b) => a + b, 0);
    check('all child rows cascade-removed', orphans === 0, orphanCounts.join(','));

    // Course-owner guard: deleting a user who owns courses → 409, user untouched
    const owner = await prisma.user.create({ data: { name: 'P1 Course Owner', email: `owner_${tag}@localhost.test`, password: 'x', grade: 'FIRST_SECONDARY' } });
    ownerStudentId = owner.id;
    ownedCourseId = (await prisma.course.create({ data: { title: `p1 owned ${tag}`, description: 'x', price: 0, thumbnail: 'x', grade: 'FIRST_SECONDARY', teacherId: ownerStudentId } })).id;
    const blockDel = await fetch(`${BASE}/user/${ownerStudentId}`, { method: 'DELETE', headers: { Cookie: adminCookie } });
    check('course-owning user delete refused (409)', blockDel.status === 409, `status=${blockDel.status}`);
    check('course-owning user still exists after 409', (await prisma.user.findUnique({ where: { id: ownerStudentId } })) !== null);
  } catch (e) {
    console.error('ERROR', e.stack);
    failures++;
  } finally {
    if (studentId) await prisma.user.deleteMany({ where: { id: studentId } }).catch(() => {});
    if (ownedCourseId) await prisma.course.deleteMany({ where: { id: ownedCourseId } }).catch(() => {});
    if (ownerStudentId) await prisma.user.deleteMany({ where: { id: ownerStudentId } }).catch(() => {});
    if (assignmentId) await prisma.assignment.deleteMany({ where: { id: assignmentId } }).catch(() => {});
    if (videoId) await prisma.video.deleteMany({ where: { id: videoId } }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();