const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- Checking for Course ID: 1 in Database ---');
  const courseId = 1;
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: {
      videos: true,
      bunnyVideos: true,
      enrollments: true,
      certificates: true,
      quizzes: true,
    }
  });

  if (!course) {
    console.log(`Course with id ${courseId} not found in database. Nothing to delete.`);
    return;
  }

  console.log(`Found Course id 1: "${course.title}". Proceeding with deletion...`);
  console.log(`Associated records: ${course.videos.length} legacy videos, ${course.bunnyVideos.length} bunny videos, ${course.enrollments.length} enrollments, ${course.quizzes.length} quizzes.`);

  await prisma.$transaction(async (tx) => {
    // 1. Delete associated video progress, answers, submissions for videos belonging to this course
    for (const v of course.videos) {
      await tx.videoProgress.deleteMany({ where: { videoId: v.id } });
      
      const quizzes = await tx.quiz.findMany({ where: { videoId: v.id } });
      for (const q of quizzes) {
        const questions = await tx.question.findMany({ where: { quizId: q.id } });
        for (const qu of questions) {
          await tx.answer.deleteMany({ where: { questionId: qu.id } });
        }
        await tx.question.deleteMany({ where: { quizId: q.id } });
      }
      await tx.quiz.deleteMany({ where: { videoId: v.id } });

      const assignments = await tx.assignment.findMany({ where: { videoId: v.id } });
      for (const a of assignments) {
        await tx.submission.deleteMany({ where: { assignmentId: a.id } });
        const aQuestions = await tx.assignmentQuestion.findMany({ where: { assignmentId: a.id } });
        for (const aq of aQuestions) {
          await tx.assignmentAnswer.deleteMany({ where: { questionId: aq.id } });
        }
        await tx.assignmentQuestion.deleteMany({ where: { assignmentId: a.id } });
      }
      await tx.assignment.deleteMany({ where: { videoId: v.id } });
    }

    // 2. Delete course-level quizzes
    for (const q of course.quizzes) {
      const questions = await tx.question.findMany({ where: { quizId: q.id } });
      for (const qu of questions) {
        await tx.answer.deleteMany({ where: { questionId: qu.id } });
      }
      await tx.question.deleteMany({ where: { quizId: q.id } });
    }
    await tx.quiz.deleteMany({ where: { courseId } });

    // 3. Delete Bunny videos
    await tx.bunnyVideo.deleteMany({ where: { courseId } });

    // 4. Delete legacy videos
    await tx.video.deleteMany({ where: { courseId } });

    // 5. Delete enrollments & certificates
    await tx.enrollment.deleteMany({ where: { courseId } });
    await tx.certificate.deleteMany({ where: { courseId } });

    // 6. Delete LearningPath relations if any
    const paths = await tx.learningPath.findMany({
      where: { courses: { some: { id: courseId } } },
      select: { id: true }
    });
    for (const p of paths) {
      await tx.learningPath.update({
        where: { id: p.id },
        data: { courses: { disconnect: { id: courseId } } }
      });
    }

    // 7. Finally delete the course
    await tx.course.delete({ where: { id: courseId } });
  }, {
    maxWait: 15000,
    timeout: 30000
  });

  console.log(`✅ Course ID: 1 and all related data successfully deleted.`);
}

main()
  .catch((e) => {
    console.error('Error during course deletion:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
