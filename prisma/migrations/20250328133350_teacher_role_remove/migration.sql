/*
  Warnings:

  - The values [TEACHER] on the enum `User_role` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the `review` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `watchhistory` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `review` DROP FOREIGN KEY `Review_courseId_fkey`;

-- DropForeignKey
ALTER TABLE `review` DROP FOREIGN KEY `Review_userId_fkey`;

-- DropForeignKey
ALTER TABLE `watchhistory` DROP FOREIGN KEY `WatchHistory_userId_fkey`;

-- DropForeignKey
ALTER TABLE `watchhistory` DROP FOREIGN KEY `WatchHistory_videoId_fkey`;

-- AlterTable
ALTER TABLE `user` MODIFY `role` ENUM('STUDENT', 'ADMIN') NOT NULL DEFAULT 'STUDENT';

-- DropTable
DROP TABLE `review`;

-- DropTable
DROP TABLE `watchhistory`;
