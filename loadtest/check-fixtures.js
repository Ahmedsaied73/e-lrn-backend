'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const c = await p.course.findUnique({ where: { slug: 'loadtestquiz' } });
  const v = await p.bunnyVideo.findUnique({ where: { slug: 'loadtestvid1' } });
  const enr = await p.enrollment.count({ where: { courseId: c.id } });
  const prog = await p.bunnyVideoProgress.count({ where: { bunnyVideoId: v.id, completed: true } });
  const q = await p.quiz.findUnique({ where: { bunnyVideoId: v.id } });
  console.log(JSON.stringify({ courseId: c.id, videoId: v.id, quizId: q ? q.id : null, enrollments: enr, progress: prog }));
  await p.$disconnect();
})();