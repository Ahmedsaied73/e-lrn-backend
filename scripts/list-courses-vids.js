'use strict';
require('dotenv').config();
const prisma = require('../src/config/db');

async function main() {
  const courses = await prisma.course.findMany({
    select: { id: true, slug: true, title: true, description: true }
  });
  console.log('COURSES:');
  for (const c of courses) {
    console.log(`Course ID: ${c.id}, slug: ${c.slug}, title: "${c.title}"`);
    const vids = await prisma.bunnyVideo.findMany({
      where: { courseId: c.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, slug: true, title: true, position: true }
    });
    console.log(`  Videos count: ${vids.length}`);
    vids.forEach(v => console.log(`    Vid ${v.id} [pos ${v.position}]: slug=${v.slug}, title="${v.title}"`));
  }
  await prisma.$disconnect();
}
main();
