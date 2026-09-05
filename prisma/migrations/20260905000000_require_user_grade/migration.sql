-- Existing NULL grades default to FIRST_SECONDARY (migration of legacy rows)
UPDATE `user` SET `grade` = 'FIRST_SECONDARY' WHERE `grade` IS NULL;

-- AlterTable: grade becomes NOT NULL, default FIRST_SECONDARY matches schema
ALTER TABLE `user` MODIFY `grade` ENUM('FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY') NOT NULL DEFAULT 'FIRST_SECONDARY';