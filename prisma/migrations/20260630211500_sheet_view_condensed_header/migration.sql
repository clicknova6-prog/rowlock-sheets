ALTER TABLE `SheetViewSetting`
  ADD COLUMN `condensedView` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `frozenHeaderRowIndex` INTEGER NULL;
