/*
  Warnings:

  - You are about to drop the column `estimatedHours` on the `course` table. All the data in the column will be lost.
  - You are about to drop the column `level` on the `course` table. All the data in the column will be lost.
  - The values [year1,year2,year3] on the enum `Course_grade` will be removed. If these variants are still used in the database, this will fail.

*/
-- Map existing level values to corresponding grade values
UPDATE `course` 
SET `course`.`level` = CASE
    WHEN `course`.`level` = 'BEGINNER' THEN 'FIRST_SECONDARY'
    WHEN `course`.`level` = 'INTERMEDIATE' THEN 'SECOND_SECONDARY'
    WHEN `course`.`level` = 'ADVANCED' OR `course`.`level` = 'EXPERT' THEN 'THIRD_SECONDARY'
    ELSE 'FIRST_SECONDARY'
END;

-- AlterTable
ALTER TABLE `course` 
    ADD COLUMN `grade` ENUM('FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY') NOT NULL DEFAULT 'FIRST_SECONDARY';

-- Update grade based on previous level values
UPDATE `course` 
SET `course`.`grade` = CASE
    WHEN `course`.`level` = 'BEGINNER' THEN 'FIRST_SECONDARY'
    WHEN `course`.`level` = 'INTERMEDIATE' THEN 'SECOND_SECONDARY'
    WHEN `course`.`level` = 'ADVANCED' OR `course`.`level` = 'EXPERT' THEN 'THIRD_SECONDARY'
    ELSE 'FIRST_SECONDARY'
END;

-- Now drop the columns after data migration
ALTER TABLE `course` DROP COLUMN `estimatedHours`,
    DROP COLUMN `level`;

-- AlterTable
ALTER TABLE `user` MODIFY `grade` ENUM('FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY') NULL;
