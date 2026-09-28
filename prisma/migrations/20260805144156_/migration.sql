-- CreateIndex
CREATE INDEX `Course_grade_idx` ON `Course`(`grade`);

-- RenameIndex
ALTER TABLE `course` RENAME INDEX `Course_teacherId_fkey` TO `Course_teacherId_idx`;

-- RenameIndex
ALTER TABLE `enrollment` RENAME INDEX `Enrollment_courseId_fkey` TO `Enrollment_courseId_idx`;

-- RenameIndex
ALTER TABLE `enrollment` RENAME INDEX `Enrollment_userId_fkey` TO `Enrollment_userId_idx`;

-- RenameIndex
ALTER TABLE `payment` RENAME INDEX `Payment_userId_fkey` TO `Payment_userId_idx`;

-- RenameIndex
ALTER TABLE `quiz` RENAME INDEX `Quiz_courseId_fkey` TO `Quiz_courseId_idx`;

-- RenameIndex
ALTER TABLE `quiz` RENAME INDEX `Quiz_videoId_fkey` TO `Quiz_videoId_idx`;

-- RenameIndex
ALTER TABLE `video` RENAME INDEX `Video_courseId_fkey` TO `Video_courseId_idx`;
