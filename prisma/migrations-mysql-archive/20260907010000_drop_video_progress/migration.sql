-- DropForeignKey
ALTER TABLE `videoprogress` DROP FOREIGN KEY `VideoProgress_userId_fkey`;

-- DropForeignKey
ALTER TABLE `videoprogress` DROP FOREIGN KEY `VideoProgress_videoId_fkey`;

-- DropTable
DROP TABLE `videoprogress`;