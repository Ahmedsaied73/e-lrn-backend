-- AlterTable
ALTER TABLE "User" ADD COLUMN "maxDevices" INTEGER;

-- CreateTable
CREATE TABLE "UserDevice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceIdentifier" VARCHAR(64) NOT NULL,
    "deviceName" VARCHAR(128),
    "deviceType" VARCHAR(32),
    "browser" VARCHAR(64),
    "os" VARCHAR(64),
    "ipAddress" VARCHAR(64),
    "userAgent" TEXT,
    "refreshToken" TEXT,
    "refreshTokenFamily" VARCHAR(36),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserDevice_userId_deviceIdentifier_key" ON "UserDevice"("userId", "deviceIdentifier");

-- CreateIndex
CREATE INDEX "UserDevice_userId_revokedAt_idx" ON "UserDevice"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "UserDevice_deviceIdentifier_idx" ON "UserDevice"("deviceIdentifier");

-- AddForeignKey
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS Lockdown for new table
ALTER TABLE "UserDevice" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "UserDevice" FROM anon, authenticated;
