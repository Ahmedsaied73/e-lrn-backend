-- DropForeignKey
ALTER TABLE `video` DROP FOREIGN KEY `Video_courseId_fkey`;

-- DropIndex
DROP INDEX `Video_courseId_fkey` ON `video`;

-- AlterTable
ALTER TABLE `course` ADD COLUMN `isYoutube` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `youtubePlaylistId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `video` ADD COLUMN `isYoutube` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `position` INTEGER NULL,
    ADD COLUMN `youtubeId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Video` ADD CONSTRAINT `Video_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
