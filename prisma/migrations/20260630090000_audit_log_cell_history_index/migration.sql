CREATE INDEX `AuditLog_sheetId_rowIndex_columnKey_createdAt_idx`
  ON `AuditLog`(`sheetId`, `rowIndex`, `columnKey`, `createdAt`);
