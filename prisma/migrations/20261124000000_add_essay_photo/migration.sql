-- AlterTable
ALTER TABLE "QuizAttempt" ADD COLUMN "essayMeta" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "essayPhotoEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "essay_photo_extractions" (
    "id" TEXT NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "examId" INTEGER NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "questionId" TEXT NOT NULL,
    "studentIdHash" TEXT NOT NULL,
    "imageSha256" CHAR(64) NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "unreadableCount" INTEGER NOT NULL,
    "imageQuality" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "thinkingTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DECIMAL(10,6) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "essay_photo_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "essay_photo_extractions_attemptId_idx" ON "essay_photo_extractions"("attemptId");

-- CreateIndex
CREATE INDEX "essay_photo_extractions_teacherId_createdAt_idx" ON "essay_photo_extractions"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "essay_photo_extractions_imageSha256_idx" ON "essay_photo_extractions"("imageSha256");
