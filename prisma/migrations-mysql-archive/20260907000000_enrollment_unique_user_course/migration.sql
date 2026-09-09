-- Add unique constraint to prevent duplicate enrollments (same user + course)
ALTER TABLE `Enrollment` ADD UNIQUE INDEX `Enrollment_userId_courseId_key`(`userId`, `courseId`);