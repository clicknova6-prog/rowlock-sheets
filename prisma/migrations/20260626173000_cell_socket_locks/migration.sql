ALTER TABLE `Cell` ADD COLUMN `lockedBy` VARCHAR(191) NULL;

CREATE INDEX `Cell_lockedBy_idx` ON `Cell`(`lockedBy`);
