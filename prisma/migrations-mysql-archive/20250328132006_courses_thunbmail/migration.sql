/*
  Warnings:

  - Added the required column `thunbmail` to the `Course` table without a default value. This is not possible if the table is not empty.
  - Added the required column `thumbnail` to the `Video` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `course` ADD COLUMN `thunbmail` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `video` ADD COLUMN `thumbnail` VARCHAR(191) NOT NULL;
