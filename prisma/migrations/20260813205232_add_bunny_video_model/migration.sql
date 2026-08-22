-- CreateTable
CREATE TABLE `BunnyVideo` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `courseId` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `bunnyVideoId` VARCHAR(191) NOT NULL,
    `bunnyLibraryId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `duration` INTEGER NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `processingProgress` INTEGER NULL DEFAULT 0,
    `thumbnailUrl` VARCHAR(191) NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BunnyVideo_bunnyVideoId_key`(`bunnyVideoId`),
    INDEX `BunnyVideo_courseId_idx`(`courseId`),
    INDEX `BunnyVideo_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BunnyVideo` ADD CONSTRAINT `BunnyVideo_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
