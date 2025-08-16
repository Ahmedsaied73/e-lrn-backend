/*
  Warnings:

  - You are about to drop the `muxdata` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `muxdata` DROP FOREIGN KEY `MuxData_videoId_fkey`;

-- DropTable
DROP TABLE `muxdata`;
