-- CreateEnum
CREATE TYPE "AiGradingJobStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "AiGradingJob" (
    "id" SERIAL NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "questionName" TEXT NOT NULL,
    "status" "AiGradingJobStatus" NOT NULL DEFAULT 'PENDING',
    "tries" INTEGER NOT NULL DEFAULT 0,
    "maxTries" INTEGER NOT NULL DEFAULT 3,
    "confidence" DOUBLE PRECISION,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "verdict" JSONB,
    "error" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiGradingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGradingJob_status_idx" ON "AiGradingJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AiGradingJob_attemptId_questionName_key" ON "AiGradingJob"("attemptId", "questionName");

-- AddForeignKey
ALTER TABLE "AiGradingJob" ADD CONSTRAINT "AiGradingJob_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
