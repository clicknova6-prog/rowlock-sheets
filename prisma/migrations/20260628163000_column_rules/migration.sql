ALTER TABLE `ColumnPermission`
  ADD COLUMN `memberWriteOnce` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `duplicateHighlight` BOOLEAN NOT NULL DEFAULT false;
