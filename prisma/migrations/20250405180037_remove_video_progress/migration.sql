/*
  Warnings:

  - You are about to drop the `videoprogress` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `videoprogress` DROP FOREIGN KEY `VideoProgress_userId_fkey`;

-- DropForeignKey
ALTER TABLE `videoprogress` DROP FOREIGN KEY `VideoProgress_videoId_fkey`;

-- DropTable
DROP TABLE `videoprogress`;
