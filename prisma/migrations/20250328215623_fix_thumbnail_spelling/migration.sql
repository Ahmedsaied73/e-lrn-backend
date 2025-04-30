/*
  Warnings:

  - You are about to drop the column `thunbmail` on the `course` table. All the data in the column will be lost.
  - Added the required column `thumbnail` to the `Course` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `course` DROP COLUMN `thunbmail`,
    ADD COLUMN `thumbnail` VARCHAR(191) NOT NULL;
