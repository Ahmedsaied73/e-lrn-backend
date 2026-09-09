-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY');

-- CreateEnum
CREATE TYPE "QuizAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'GRADING', 'GRADED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'GRADED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "grade" "Grade" NOT NULL DEFAULT 'FIRST_SECONDARY',
    "refreshToken" TEXT,
    "refreshTokenFamily" VARCHAR(36),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT,
    "grade" "Grade" NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "courseId" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "position" INTEGER,
    "description" TEXT,
    "transcript" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paymentDate" TIMESTAMP(3),
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastAccess" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "certificateNumber" TEXT NOT NULL,
    "certificateUrl" TEXT,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningPath" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningPath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quiz" (
    "id" SERIAL NOT NULL,
    "bunnyVideoId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "timeLimitSec" INTEGER,
    "passingScore" INTEGER NOT NULL DEFAULT 50,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "surveyJson" JSONB NOT NULL,
    "answerKey" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizAttempt" (
    "id" SERIAL NOT NULL,
    "quizId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "QuizAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "responses" JSONB,
    "mcqEarned" INTEGER,
    "essayEarned" INTEGER,
    "totalPoints" INTEGER,
    "earnedPoints" INTEGER,
    "scorePercent" DOUBLE PRECISION,
    "essayFeedback" JSONB,
    "essayGradedBy" INTEGER,
    "essayGradedAt" TIMESTAMP(3),

    CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateExemption" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bunnyVideoId" INTEGER NOT NULL,
    "grantedBy" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateExemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "videoId" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3),
    "isMCQ" BOOLEAN NOT NULL DEFAULT false,
    "passingScore" DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentQuestion" (
    "id" SERIAL NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOption" INTEGER NOT NULL,
    "explanation" TEXT,
    "points" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentAnswer" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "questionId" INTEGER NOT NULL,
    "selectedOption" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "content" TEXT,
    "fileUrl" TEXT,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "grade" DOUBLE PRECISION,
    "feedback" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gradedAt" TIMESTAMP(3),
    "mcqScore" DOUBLE PRECISION,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BunnyVideo" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER,
    "bunnyVideoId" TEXT NOT NULL,
    "bunnyLibraryId" TEXT NOT NULL,
    "status" "VideoStatus" NOT NULL DEFAULT 'PENDING',
    "duration" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "processingProgress" INTEGER DEFAULT 0,
    "thumbnailUrl" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BunnyVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BunnyVideoProgress" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bunnyVideoId" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "watchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BunnyVideoProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CoursesInPath" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "_Prerequisites" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE INDEX "Course_teacherId_idx" ON "Course"("teacherId");

-- CreateIndex
CREATE INDEX "Course_grade_idx" ON "Course"("grade");

-- CreateIndex
CREATE INDEX "Video_courseId_idx" ON "Video"("courseId");

-- CreateIndex
CREATE INDEX "Enrollment_userId_idx" ON "Enrollment"("userId");

-- CreateIndex
CREATE INDEX "Enrollment_courseId_idx" ON "Enrollment"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_userId_courseId_key" ON "Enrollment"("userId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_certificateNumber_key" ON "Certificate"("certificateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_userId_courseId_key" ON "Certificate"("userId", "courseId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Quiz_bunnyVideoId_key" ON "Quiz"("bunnyVideoId");

-- CreateIndex
CREATE INDEX "Quiz_bunnyVideoId_idx" ON "Quiz"("bunnyVideoId");

-- CreateIndex
CREATE INDEX "QuizAttempt_userId_quizId_idx" ON "QuizAttempt"("userId", "quizId");

-- CreateIndex
CREATE INDEX "QuizAttempt_quizId_idx" ON "QuizAttempt"("quizId");

-- CreateIndex
CREATE INDEX "QuizAttempt_userId_idx" ON "QuizAttempt"("userId");

-- CreateIndex
CREATE INDEX "GateExemption_bunnyVideoId_idx" ON "GateExemption"("bunnyVideoId");

-- CreateIndex
CREATE UNIQUE INDEX "GateExemption_userId_bunnyVideoId_key" ON "GateExemption"("userId", "bunnyVideoId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentAnswer_userId_questionId_key" ON "AssignmentAnswer"("userId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_userId_assignmentId_key" ON "Submission"("userId", "assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BunnyVideo_bunnyVideoId_key" ON "BunnyVideo"("bunnyVideoId");

-- CreateIndex
CREATE INDEX "BunnyVideo_courseId_idx" ON "BunnyVideo"("courseId");

-- CreateIndex
CREATE INDEX "BunnyVideo_status_idx" ON "BunnyVideo"("status");

-- CreateIndex
CREATE INDEX "BunnyVideoProgress_bunnyVideoId_idx" ON "BunnyVideoProgress"("bunnyVideoId");

-- CreateIndex
CREATE UNIQUE INDEX "BunnyVideoProgress_userId_bunnyVideoId_key" ON "BunnyVideoProgress"("userId", "bunnyVideoId");

-- CreateIndex
CREATE UNIQUE INDEX "_CoursesInPath_AB_unique" ON "_CoursesInPath"("A", "B");

-- CreateIndex
CREATE INDEX "_CoursesInPath_B_index" ON "_CoursesInPath"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_Prerequisites_AB_unique" ON "_Prerequisites"("A", "B");

-- CreateIndex
CREATE INDEX "_Prerequisites_B_index" ON "_Prerequisites"("B");

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_bunnyVideoId_fkey" FOREIGN KEY ("bunnyVideoId") REFERENCES "BunnyVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateExemption" ADD CONSTRAINT "GateExemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentQuestion" ADD CONSTRAINT "AssignmentQuestion_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentAnswer" ADD CONSTRAINT "AssignmentAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentAnswer" ADD CONSTRAINT "AssignmentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AssignmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BunnyVideo" ADD CONSTRAINT "BunnyVideo_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BunnyVideoProgress" ADD CONSTRAINT "BunnyVideoProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BunnyVideoProgress" ADD CONSTRAINT "BunnyVideoProgress_bunnyVideoId_fkey" FOREIGN KEY ("bunnyVideoId") REFERENCES "BunnyVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CoursesInPath" ADD CONSTRAINT "_CoursesInPath_A_fkey" FOREIGN KEY ("A") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CoursesInPath" ADD CONSTRAINT "_CoursesInPath_B_fkey" FOREIGN KEY ("B") REFERENCES "LearningPath"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_Prerequisites" ADD CONSTRAINT "_Prerequisites_A_fkey" FOREIGN KEY ("A") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_Prerequisites" ADD CONSTRAINT "_Prerequisites_B_fkey" FOREIGN KEY ("B") REFERENCES "LearningPath"("id") ON DELETE CASCADE ON UPDATE CASCADE;
