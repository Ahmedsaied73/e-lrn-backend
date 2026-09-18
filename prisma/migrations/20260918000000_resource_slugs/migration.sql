-- Add public URL slugs to User, Course, BunnyVideo, Quiz.
-- Backfill keeps existing rows deterministic/unique (users get opaque u_<uuid>),
-- then the columns become NOT NULL with a unique index enforced at the DB.

ALTER TABLE "User" ADD COLUMN "slug" TEXT;
ALTER TABLE "Course" ADD COLUMN "slug" TEXT;
ALTER TABLE "BunnyVideo" ADD COLUMN "slug" TEXT;
ALTER TABLE "Quiz" ADD COLUMN "slug" TEXT;

UPDATE "User" SET "slug" = 'u_' || replace(gen_random_uuid()::text, '-', '') WHERE "slug" IS NULL;
UPDATE "Course" SET "slug" = 'course-' || "id" WHERE "slug" IS NULL;
UPDATE "BunnyVideo" SET "slug" = 'video-' || "id" WHERE "slug" IS NULL;
UPDATE "Quiz" SET "slug" = 'quiz-' || "id" WHERE "slug" IS NULL;

ALTER TABLE "User" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Course" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "BunnyVideo" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "Quiz" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "User_slug_key" ON "User"("slug");
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");
CREATE UNIQUE INDEX "BunnyVideo_slug_key" ON "BunnyVideo"("slug");
CREATE UNIQUE INDEX "Quiz_slug_key" ON "Quiz"("slug");