-- CreateTable
CREATE TABLE `MuxData` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assetId` VARCHAR(191) NOT NULL,
    `playbackId` VARCHAR(191) NULL,
    `uploadId` VARCHAR(191) NULL,
    `isProcessed` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PREPARING', 'READY', 'ERRORED', 'DELETED') NOT NULL DEFAULT 'PREPARING',
    `duration` DOUBLE NULL,
    `aspectRatio` VARCHAR(191) NULL,
    `resolution` VARCHAR(191) NULL,
    `fileSize` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `muxCreatedAt` DATETIME(3) NULL,
    `muxUpdatedAt` DATETIME(3) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `videoId` INTEGER NOT NULL,

    UNIQUE INDEX `MuxData_assetId_key`(`assetId`),
    UNIQUE INDEX `MuxData_playbackId_key`(`playbackId`),
    UNIQUE INDEX `MuxData_uploadId_key`(`uploadId`),
    UNIQUE INDEX `MuxData_videoId_key`(`videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MuxData` ADD CONSTRAINT `MuxData_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `Video`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
