import type { ColumnKey } from "@/lib/constants";
import type { SheetGridRow, SheetSnapshot } from "./types";

export interface CellUpdateReference {
  rowIndex: number;
  columnKey: ColumnKey;
}

function rowHasFormula(row: SheetGridRow, columns: SheetSnapshot["columns"]): boolean {
  return columns.some((columnKey) => row.__formula[columnKey] === true);
}

export function getRowsForPersistedCellUpdates(
  snapshot: SheetSnapshot,
  updates: CellUpdateReference[]
): SheetGridRow[] {
  const touchedRowIndexes = new Set(updates.map((update) => update.rowIndex));
  const touchedColumns = new Set(updates.map((update) => update.columnKey));
  const hasFormulaRows = snapshot.rows.some((row) => rowHasFormula(row, snapshot.columns));
  const hasAnyDuplicateHighlight = snapshot.columnPermissions.some(
    (permission) => permission.duplicateHighlight
  );
  const hasTouchedDuplicateColumn = snapshot.columnPermissions.some(
    (permission) => permission.duplicateHighlight && touchedColumns.has(permission.columnKey)
  );

  if (hasTouchedDuplicateColumn || (hasAnyDuplicateHighlight && hasFormulaRows)) {
    return snapshot.rows;
  }

  const rowIndexesToSend = new Set(touchedRowIndexes);

  if (hasFormulaRows) {
    for (const row of snapshot.rows) {
      if (rowHasFormula(row, snapshot.columns)) {
        rowIndexesToSend.add(row.rowNumber);
      }
    }
  }

  return snapshot.rows.filter((row) => rowIndexesToSend.has(row.rowNumber));
}
