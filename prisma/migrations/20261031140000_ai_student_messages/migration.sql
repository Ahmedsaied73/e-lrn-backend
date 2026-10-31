-- CreateEnum
CREATE TYPE "AiStudentRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "AiStudentMessage" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "AiStudentRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiStudentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiStudentMessage_userId_sessionId_createdAt_idx" ON "AiStudentMessage"("userId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiStudentMessage_createdAt_idx" ON "AiStudentMessage"("createdAt");

-- AddForeignKey
ALTER TABLE "AiStudentMessage" ADD CONSTRAINT "AiStudentMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
