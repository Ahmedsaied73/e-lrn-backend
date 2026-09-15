-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "bunnyVideoId" INTEGER,
ALTER COLUMN "videoId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordResetExpires" TIMESTAMP(3),
ADD COLUMN     "passwordResetToken" TEXT;

-- CreateIndex
CREATE INDEX "Assignment_bunnyVideoId_idx" ON "Assignment"("bunnyVideoId");

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_bunnyVideoId_fkey" FOREIGN KEY ("bunnyVideoId") REFERENCES "BunnyVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
