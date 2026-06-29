ALTER TABLE `ColumnPermission`
  ADD COLUMN `claimRowOnEdit` BOOLEAN NOT NULL DEFAULT false;

UPDATE `ColumnPermission`
SET `claimRowOnEdit` = `editableByMember`;
