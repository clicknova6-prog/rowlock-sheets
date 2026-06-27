import { HyperFormula } from "hyperformula";
import { COLUMN_KEYS, MAX_ROWS, getCellKey } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import type { CellState } from "./types";

export interface RecalculatedCell {
  rowIndex: number;
  columnKey: ColumnKey;
  computedValue: string;
}

function formatFormulaValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    const maybeError = value as { value?: unknown; type?: unknown };
    return String(maybeError.value ?? maybeError.type ?? "#ERROR!");
  }

  return String(value);
}

export function isFormula(value: string): boolean {
  return value.trim().startsWith("=");
}

export function normalizeCellInput(value: string): Pick<CellState, "value" | "formula"> {
  const trimmed = value.trim();

  if (isFormula(trimmed)) {
    return {
      value: "",
      formula: trimmed
    };
  }

  return {
    value,
    formula: null
  };
}

export function recalculateCells(
  cells: CellState[],
  rowCount = MAX_ROWS
): RecalculatedCell[] {
  const matrix = Array.from({ length: rowCount }, () =>
    Array.from({ length: COLUMN_KEYS.length }, () => "")
  );

  for (const cell of cells) {
    const rowIndex = cell.rowIndex - 1;
    const columnIndex = COLUMN_KEYS.indexOf(cell.columnKey);

    if (rowIndex >= 0 && rowIndex < rowCount && columnIndex >= 0) {
      matrix[rowIndex][columnIndex] = cell.formula ?? cell.value ?? "";
    }
  }

  const engine = HyperFormula.buildFromArray(matrix, {
    licenseKey: "gpl-v3",
    maxColumns: COLUMN_KEYS.length,
    maxRows: rowCount
  });

  try {
    const calculated = engine.getSheetValues(0);
    const recalculated: RecalculatedCell[] = [];

    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      for (const columnKey of COLUMN_KEYS) {
        const columnIndex = COLUMN_KEYS.indexOf(columnKey);
        recalculated.push({
          rowIndex,
          columnKey,
          computedValue: formatFormulaValue(calculated[rowIndex - 1]?.[columnIndex])
        });
      }
    }

    return recalculated;
  } finally {
    engine.destroy();
  }
}

export function mergeRecalculatedCells(
  cells: CellState[],
  recalculated: RecalculatedCell[]
): CellState[] {
  const computedLookup = new Map(
    recalculated.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell.computedValue])
  );

  return cells.map((cell) => ({
    ...cell,
    computedValue:
      computedLookup.get(getCellKey(cell.rowIndex, cell.columnKey)) ?? cell.computedValue ?? ""
  }));
}
