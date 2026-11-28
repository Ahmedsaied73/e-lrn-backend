-- CreateEnum
CREATE TYPE "XpEventType" AS ENUM ('LESSON_COMPLETE', 'QUIZ_CORRECT_DELTA', 'QUIZ_PERFECT', 'QUIZ_IMPROVEMENT', 'STREAK_DAILY', 'TEACHER_CHALLENGE');

-- CreateEnum
CREATE TYPE "TeacherChallengeKind" AS ENUM ('MASTERY', 'STREAK_ANSWERS', 'IMPROVE', 'MISTAKES', 'NO_SKIP', 'AI_ESSAY');

-- CreateTable
CREATE TABLE "TeacherSettings" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "gamificationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentGamification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "studentId" INTEGER NOT NULL,
    "totalXp" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDayKey" TEXT,
    "completedLessonsCnt" INTEGER NOT NULL DEFAULT 0,
    "completedQuizzesCnt" INTEGER NOT NULL DEFAULT 0,
    "perfectQuizzesCnt" INTEGER NOT NULL DEFAULT 0,
    "improvedQuizzesCnt" INTEGER NOT NULL DEFAULT 0,
    "passedChallengesCnt" INTEGER NOT NULL DEFAULT 0,
    "completedCoursesCnt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentGamification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "studentId" INTEGER NOT NULL,
    "type" "XpEventType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentBadge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "studentId" INTEGER NOT NULL,
    "badgeCode" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseChallenge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "courseId" INTEGER NOT NULL,
    "kind" "TeacherChallengeKind" NOT NULL DEFAULT 'MASTERY',
    "quizId" INTEGER,
    "title" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "masteryPercent" INTEGER NOT NULL DEFAULT 80,
    "rewardXp" INTEGER NOT NULL DEFAULT 120,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSettings_tenantId_key" ON "TeacherSettings"("tenantId");

-- CreateIndex
CREATE INDEX "StudentGamification_tenantId_updatedAt_idx" ON "StudentGamification"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "StudentGamification_studentId_idx" ON "StudentGamification"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentGamification_tenantId_studentId_key" ON "StudentGamification"("tenantId", "studentId");

-- CreateIndex
CREATE INDEX "XpEvent_tenantId_studentId_createdAt_idx" ON "XpEvent"("tenantId", "studentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "XpEvent_studentId_idx" ON "XpEvent"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "XpEvent_tenantId_studentId_idempotencyKey_key" ON "XpEvent"("tenantId", "studentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StudentBadge_tenantId_studentId_idx" ON "StudentBadge"("tenantId", "studentId");

-- CreateIndex
CREATE INDEX "StudentBadge_studentId_idx" ON "StudentBadge"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentBadge_tenantId_studentId_badgeCode_key" ON "StudentBadge"("tenantId", "studentId", "badgeCode");

-- CreateIndex
CREATE UNIQUE INDEX "CourseChallenge_courseId_key" ON "CourseChallenge"("courseId");

-- CreateIndex
CREATE INDEX "CourseChallenge_tenantId_courseId_idx" ON "CourseChallenge"("tenantId", "courseId");

-- CreateIndex
CREATE INDEX "CourseChallenge_quizId_idx" ON "CourseChallenge"("quizId");

-- AddForeignKey
ALTER TABLE "StudentGamification" ADD CONSTRAINT "StudentGamification_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XpEvent" ADD CONSTRAINT "XpEvent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentBadge" ADD CONSTRAINT "StudentBadge_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChallenge" ADD CONSTRAINT "CourseChallenge_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChallenge" ADD CONSTRAINT "CourseChallenge_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE SET NULL ON UPDATE CASCADE;
