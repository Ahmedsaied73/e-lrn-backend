-- AlterTable
ALTER TABLE `submission` ADD COLUMN `mcqScore` DOUBLE NULL;

-- CreateTable
CREATE TABLE `AssignmentQuestion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assignmentId` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `correctOption` INTEGER NOT NULL,
    `explanation` TEXT NULL,
    `points` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AssignmentAnswer` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `questionId` INTEGER NOT NULL,
    `selectedOption` INTEGER NOT NULL,
    `isCorrect` BOOLEAN NOT NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AssignmentAnswer_userId_questionId_key`(`userId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AssignmentQuestion` ADD CONSTRAINT `AssignmentQuestion_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `Assignment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssignmentAnswer` ADD CONSTRAINT `AssignmentAnswer_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssignmentAnswer` ADD CONSTRAINT `AssignmentAnswer_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `AssignmentQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
