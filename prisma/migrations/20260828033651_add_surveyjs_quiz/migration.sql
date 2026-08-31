/*
  Warnings:

  - You are about to drop the column `isYoutube` on the `course` table. All the data in the column will be lost.
  - You are about to drop the column `youtubePlaylistId` on the `course` table. All the data in the column will be lost.
  - You are about to drop the column `courseId` on the `quiz` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `quiz` table. All the data in the column will be lost.
  - You are about to drop the column `isFinal` on the `quiz` table. All the data in the column will be lost.
  - You are about to drop the column `isYoutube` on the `video` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeId` on the `video` table. All the data in the column will be lost.
  - You are about to drop the `answer` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `question` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[videoId]` on the table `Quiz` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `answerKey` to the `Quiz` table without a default value. This is not possible if the table is not empty.
  - Added the required column `surveyJson` to the `Quiz` table without a default value. This is not possible if the table is not empty.
  - Made the column `videoId` on table `quiz` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE `answer` DROP FOREIGN KEY `Answer_questionId_fkey`;

-- DropForeignKey
ALTER TABLE `answer` DROP FOREIGN KEY `Answer_userId_fkey`;

-- DropForeignKey
ALTER TABLE `question` DROP FOREIGN KEY `Question_quizId_fkey`;

-- DropForeignKey
ALTER TABLE `quiz` DROP FOREIGN KEY `Quiz_courseId_fkey`;

-- DropForeignKey
ALTER TABLE `quiz` DROP FOREIGN KEY `Quiz_videoId_fkey`;

-- AlterTable
ALTER TABLE `course` DROP COLUMN `isYoutube`,
    DROP COLUMN `youtubePlaylistId`;

-- AlterTable
ALTER TABLE `quiz` DROP COLUMN `courseId`,
    DROP COLUMN `description`,
    DROP COLUMN `isFinal`,
    ADD COLUMN `answerKey` JSON NOT NULL,
    ADD COLUMN `surveyJson` JSON NOT NULL,
    ADD COLUMN `timeLimitSec` INTEGER NULL,
    MODIFY `passingScore` INTEGER NOT NULL DEFAULT 50,
    MODIFY `videoId` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `video` DROP COLUMN `isYoutube`,
    DROP COLUMN `youtubeId`;

-- DropTable
DROP TABLE `answer`;

-- DropTable
DROP TABLE `question`;

-- CreateTable
CREATE TABLE `QuizAttempt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `quizId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('IN_PROGRESS', 'SUBMITTED', 'GRADING', 'GRADED', 'EXPIRED') NOT NULL DEFAULT 'IN_PROGRESS',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadlineAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `autoSubmitted` BOOLEAN NOT NULL DEFAULT false,
    `responses` JSON NULL,
    `mcqEarned` INTEGER NULL,
    `essayEarned` INTEGER NULL,
    `totalPoints` INTEGER NULL,
    `earnedPoints` INTEGER NULL,
    `scorePercent` DOUBLE NULL,
    `essayFeedback` JSON NULL,
    `essayGradedBy` INTEGER NULL,
    `essayGradedAt` DATETIME(3) NULL,

    INDEX `QuizAttempt_userId_quizId_idx`(`userId`, `quizId`),
    INDEX `QuizAttempt_quizId_idx`(`quizId`),
    INDEX `QuizAttempt_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GateExemption` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `videoId` INTEGER NOT NULL,
    `grantedBy` INTEGER NOT NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GateExemption_videoId_idx`(`videoId`),
    UNIQUE INDEX `GateExemption_userId_videoId_key`(`userId`, `videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Quiz_videoId_key` ON `Quiz`(`videoId`);

-- AddForeignKey
ALTER TABLE `Quiz` ADD CONSTRAINT `Quiz_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `Video`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizAttempt` ADD CONSTRAINT `QuizAttempt_quizId_fkey` FOREIGN KEY (`quizId`) REFERENCES `Quiz`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuizAttempt` ADD CONSTRAINT `QuizAttempt_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GateExemption` ADD CONSTRAINT `GateExemption_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
