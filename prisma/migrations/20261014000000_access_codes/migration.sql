-- CreateEnum
CREATE TYPE "AccessCodeStatus" AS ENUM ('AVAILABLE', 'REDEEMED', 'REVOKED');

-- CreateTable
CREATE TABLE "AccessBatch" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "codeLength" INTEGER NOT NULL DEFAULT 8,
    "label" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generatedBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "batchId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "status" "AccessCodeStatus" NOT NULL DEFAULT 'AVAILABLE',
    "redeemedBy" INTEGER,
    "redeemedAt" TIMESTAMP(3),
    "revokedBy" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessBatch_courseId_idx" ON "AccessBatch"("courseId");

-- CreateIndex
CREATE INDEX "AccessBatch_generatedBy_idx" ON "AccessBatch"("generatedBy");

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");

-- CreateIndex
CREATE INDEX "AccessCode_batchId_idx" ON "AccessCode"("batchId");

-- CreateIndex
CREATE INDEX "AccessCode_courseId_idx" ON "AccessCode"("courseId");

-- CreateIndex
CREATE INDEX "AccessCode_status_courseId_idx" ON "AccessCode"("status", "courseId");

-- AddForeignKey
ALTER TABLE "AccessBatch" ADD CONSTRAINT "AccessBatch_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AccessBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS Lockdown for new tables
ALTER TABLE "AccessBatch" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "AccessBatch" FROM anon, authenticated;

ALTER TABLE "AccessCode" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "AccessCode" FROM anon, authenticated;
