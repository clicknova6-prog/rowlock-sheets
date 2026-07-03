ALTER TABLE `ColumnPermission`
  ADD COLUMN `memberEditDelaySourceColumnKey` VARCHAR(1) NULL,
  ADD COLUMN `memberEditDelayMinutes` INTEGER NOT NULL DEFAULT 0;
