ALTER TABLE `AuditLog` MODIFY `action` ENUM(
  'CELL_UPDATED',
  'CELL_FORMAT_UPDATED',
  'ROW_CLAIMED',
  'ROW_UNLOCKED',
  'COLUMN_PERMISSION_UPDATED',
  'VALIDATION_RULE_UPDATED',
  'CONDITIONAL_RULE_UPDATED',
  'SHEET_VIEW_UPDATED',
  'USER_SIGNED_IN'
) NOT NULL;

CREATE TABLE `CellFormat` (
  `id` VARCHAR(191) NOT NULL,
  `sheetId` VARCHAR(191) NOT NULL,
  `rowIndex` INTEGER NOT NULL,
  `columnKey` VARCHAR(1) NOT NULL,
  `bold` BOOLEAN NOT NULL DEFAULT false,
  `italic` BOOLEAN NOT NULL DEFAULT false,
  `underline` BOOLEAN NOT NULL DEFAULT false,
  `textColor` VARCHAR(20) NULL,
  `backgroundColor` VARCHAR(20) NULL,
  `horizontalAlign` VARCHAR(10) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `CellFormat_sheetId_rowIndex_idx`(`sheetId`, `rowIndex`),
  INDEX `CellFormat_sheetId_columnKey_idx`(`sheetId`, `columnKey`),
  UNIQUE INDEX `CellFormat_sheetId_rowIndex_columnKey_key`(`sheetId`, `rowIndex`, `columnKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SheetViewSetting` (
  `id` VARCHAR(191) NOT NULL,
  `sheetId` VARCHAR(191) NOT NULL,
  `alternateRowColors` BOOLEAN NOT NULL DEFAULT false,
  `alternateOddColor` VARCHAR(20) NOT NULL DEFAULT '#ffffff',
  `alternateEvenColor` VARCHAR(20) NOT NULL DEFAULT '#f8fafc',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `SheetViewSetting_sheetId_key`(`sheetId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CellFormat` ADD CONSTRAINT `CellFormat_sheetId_fkey` FOREIGN KEY (`sheetId`) REFERENCES `Sheet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SheetViewSetting` ADD CONSTRAINT `SheetViewSetting_sheetId_fkey` FOREIGN KEY (`sheetId`) REFERENCES `Sheet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
