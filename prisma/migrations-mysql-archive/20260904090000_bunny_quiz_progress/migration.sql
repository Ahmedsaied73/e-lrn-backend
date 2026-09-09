ALTER TABLE `Quiz` DROP FOREIGN KEY `Quiz_videoId_fkey`;
DROP INDEX `Quiz_videoId_key` ON `Quiz`;
ALTER TABLE `Quiz` CHANGE COLUMN `videoId` `bunnyVideoId` INTEGER NOT NULL;
CREATE UNIQUE INDEX `Quiz_bunnyVideoId_key` ON `Quiz`(`bunnyVideoId`);
CREATE INDEX `Quiz_bunnyVideoId_idx` ON `Quiz`(`bunnyVideoId`);
ALTER TABLE `Quiz` ADD CONSTRAINT `Quiz_bunnyVideoId_fkey` FOREIGN KEY (`bunnyVideoId`) REFERENCES `BunnyVideo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX `GateExemption_userId_idx` ON `GateExemption`(`userId`);
ALTER TABLE `GateExemption` DROP INDEX `GateExemption_userId_videoId_key`;
DROP INDEX `GateExemption_videoId_idx` ON `GateExemption`;
ALTER TABLE `GateExemption` CHANGE COLUMN `videoId` `bunnyVideoId` INTEGER NOT NULL;
CREATE UNIQUE INDEX `GateExemption_userId_bunnyVideoId_key` ON `GateExemption`(`userId`, `bunnyVideoId`);
CREATE INDEX `GateExemption_bunnyVideoId_idx` ON `GateExemption`(`bunnyVideoId`);

CREATE TABLE `BunnyVideoProgress` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `bunnyVideoId` INTEGER NOT NULL,
    `completed` BOOLEAN NOT NULL DEFAULT false,
    `watchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BunnyVideoProgress_userId_bunnyVideoId_key`(`userId`, `bunnyVideoId`),
    INDEX `BunnyVideoProgress_bunnyVideoId_idx`(`bunnyVideoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BunnyVideoProgress` ADD CONSTRAINT `BunnyVideoProgress_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `BunnyVideoProgress` ADD CONSTRAINT `BunnyVideoProgress_bunnyVideoId_fkey` FOREIGN KEY (`bunnyVideoId`) REFERENCES `BunnyVideo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
