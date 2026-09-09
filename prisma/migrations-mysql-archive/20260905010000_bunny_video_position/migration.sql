-- AlterTable
ALTER TABLE `BunnyVideo` ADD COLUMN `position` INTEGER NULL;

-- Backfill positions for existing rows ordered by creation within each course
UPDATE `BunnyVideo` b
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY courseId ORDER BY createdAt ASC, id ASC) AS rn
    FROM `BunnyVideo`
) o ON o.id = b.id
SET b.position = o.rn;