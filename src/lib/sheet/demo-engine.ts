import { Role } from "@/generated/prisma/enums";
import { COLUMN_KEYS, MAX_ROWS, getCellKey, isValidRowIndex } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import {
  createDefaultCellFormat,
  isDefaultCellFormat,
  mergeCellFormat,
  normalizeFormatPatch
} from "./formatting";
import { mergeRecalculatedCells, normalizeCellInput, recalculateCells } from "./formulas";
import { getCellEditDecision } from "./permissions";
import { evaluateConditionalRules } from "./rules";
import { validateAllowedValue } from "./validation";
import type {
  Actor,
  AuditLogState,
  CellFormatEntryState,
  CellFormatPatch,
  CellState,
  ColumnPermissionState,
  RowOwnershipState,
  SheetGridRow,
  SheetSnapshot
} from "./types";

function emptyStringColumns(): Record<ColumnKey, string> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, ""])) as Record<
    ColumnKey,
    string
  >;
}

function emptyBooleanColumns(): Record<ColumnKey, boolean> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, false])) as Record<
    ColumnKey,
    boolean
  >;
}

function emptyNullableColumns(): Record<ColumnKey, string | null> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, null])) as Record<
    ColumnKey,
    string | null
  >;
}

function emptyFormatColumns(): Record<ColumnKey, ReturnType<typeof createDefaultCellFormat>> {
  return Object.fromEntries(
    COLUMN_KEYS.map((columnKey) => [columnKey, createDefaultCellFormat()])
  ) as Record<ColumnKey, ReturnType<typeof createDefaultCellFormat>>;
}

function cellsFromSnapshot(snapshot: SheetSnapshot): CellState[] {
  const cells: CellState[] = [];

  for (const row of snapshot.rows) {
    for (const columnKey of COLUMN_KEYS) {
      const value = String(row[columnKey] ?? "");

      if (value || row.__formula[columnKey]) {
        cells.push({
          rowIndex: row.rowNumber,
          columnKey,
          value: row.__formula[columnKey] ? "" : value,
          formula: row.__formula[columnKey] ? value : null,
          computedValue: row.__computed[columnKey]
        });
      }
    }
  }

  return cells;
}

function formatsFromSnapshot(snapshot: SheetSnapshot): CellFormatEntryState[] {
  const formats: CellFormatEntryState[] = [];

  for (const row of snapshot.rows) {
    for (const columnKey of COLUMN_KEYS) {
      const format = row.__format[columnKey];

      if (!isDefaultCellFormat(format)) {
        formats.push({
          rowIndex: row.rowNumber,
          columnKey,
          ...format
        });
      }
    }
  }

  return formats;
}

function ownershipsFromSnapshot(snapshot: SheetSnapshot): RowOwnershipState[] {
  return snapshot.rows
    .filter((row) => row.ownerId)
    .map((row) => ({
      rowIndex: row.rowNumber,
      ownerId: row.ownerId!,
      ownerName: row.ownerName,
      updatedAt: row.updatedAt
    }));
}

function upsertCell(cells: CellState[], editedCell: CellState): CellState[] {
  const lookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));
  lookup.set(getCellKey(editedCell.rowIndex, editedCell.columnKey), editedCell);
  return [...lookup.values()];
}

function getDuplicateHighlightedRows(
  cells: CellState[],
  columnPermissions: ColumnPermissionState[]
): Set<number> {
  const highlightedRows = new Set<number>();
  const cellLookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));
  const duplicateColumns = columnPermissions
    .filter((permission) => permission.duplicateHighlight)
    .map((permission) => permission.columnKey);

  for (const columnKey of duplicateColumns) {
    const valueRows = new Map<string, number[]>();

    for (let rowIndex = 1; rowIndex <= MAX_ROWS; rowIndex += 1) {
      const cell = cellLookup.get(getCellKey(rowIndex, columnKey));
      const value = (cell?.computedValue ?? cell?.value ?? "").trim().toLowerCase();

      if (!value) {
        continue;
      }

      valueRows.set(value, [...(valueRows.get(value) ?? []), rowIndex]);
    }

    for (const rows of valueRows.values()) {
      if (rows.length > 1) {
        rows.forEach((rowIndex) => highlightedRows.add(rowIndex));
      }
    }
  }

  return highlightedRows;
}

export function getDemoCellsFromSnapshot(snapshot: SheetSnapshot): CellState[] {
  return cellsFromSnapshot(snapshot);
}

export function buildRowsFromCells(
  snapshot: Omit<SheetSnapshot, "rows">,
  cells: CellState[],
  ownerships: RowOwnershipState[],
  formats: CellFormatEntryState[] = []
): SheetGridRow[] {
  const cellLookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));
  const formatLookup = new Map(
    formats.map((format) => [getCellKey(format.rowIndex, format.columnKey), format])
  );
  const ownershipLookup = new Map(ownerships.map((ownership) => [ownership.rowIndex, ownership]));
  const duplicateHighlightedRows = getDuplicateHighlightedRows(cells, snapshot.columnPermissions);
  const rows: SheetGridRow[] = [];

  for (let rowIndex = 1; rowIndex <= MAX_ROWS; rowIndex += 1) {
    const values = emptyStringColumns();
    const computed = emptyStringColumns();
    const formulas = emptyBooleanColumns();
    const editable = emptyBooleanColumns();
    const lockReason = emptyNullableColumns();
    const format = emptyFormatColumns();
    const ownership = ownershipLookup.get(rowIndex) ?? null;

    for (const columnKey of COLUMN_KEYS) {
      const cell = cellLookup.get(getCellKey(rowIndex, columnKey));
      const cellFormat = formatLookup.get(getCellKey(rowIndex, columnKey));
      values[columnKey] = cell?.formula ?? cell?.value ?? "";
      computed[columnKey] = cell?.computedValue ?? cell?.value ?? "";
      formulas[columnKey] = Boolean(cell?.formula);
      format[columnKey] = cellFormat ?? createDefaultCellFormat();

      const decision = getCellEditDecision({
        role: snapshot.currentUser.role,
        userId: snapshot.currentUser.id,
        columnKey,
        columnPermissions: snapshot.columnPermissions,
        ownership,
        currentValue: values[columnKey]
      });

      editable[columnKey] = decision.allowed;
      lockReason[columnKey] = decision.reason;
    }

    rows.push({
      rowNumber: rowIndex,
      ownerId: ownership?.ownerId ?? null,
      ownerName: ownership?.ownerName ?? null,
      lastEditedBy: null,
      updatedAt: ownership?.updatedAt ?? null,
      __computed: computed,
      __formula: formulas,
      __editable: editable,
      __lockReason: lockReason,
      __format: format,
      __duplicateHighlight: duplicateHighlightedRows.has(rowIndex),
      ...values
    });
  }

  return rows;
}

function appendAuditLog(
  snapshot: SheetSnapshot,
  actor: Actor,
  rowIndex: number,
  columnKey: ColumnKey,
  previousCell: CellState | undefined,
  nextCell: CellState
): AuditLogState[] {
  return [
    {
      id: `demo-audit-${Date.now()}`,
      action: "CELL_UPDATED",
      actorName: actor.name,
      rowIndex,
      columnKey,
      message: `${actor.name} updated ${columnKey}${rowIndex} in local demo mode.`,
      metadata: {
        previousValue: previousCell?.formula ?? previousCell?.value ?? "",
        value: nextCell.formula ?? nextCell.value,
        previousComputedValue: previousCell?.computedValue ?? previousCell?.value ?? "",
        computedValue: nextCell.computedValue ?? nextCell.value,
        previousFormula: previousCell?.formula ?? null,
        formula: nextCell.formula ?? null
      },
      createdAt: new Date().toISOString()
    },
    ...snapshot.auditLogs
  ].slice(0, 30);
}

export function applyDemoCellUpdate(
  snapshot: SheetSnapshot,
  rowIndex: number,
  columnKey: ColumnKey,
  value: string
): { snapshot?: SheetSnapshot; error?: string } {
  if (!isValidRowIndex(rowIndex)) {
    return { error: "Rows must be between 1 and 1000." };
  }

  const ownerships = ownershipsFromSnapshot(snapshot);
  const ownership = ownerships.find((item) => item.rowIndex === rowIndex) ?? null;
  const previousCell = cellsFromSnapshot(snapshot).find(
    (cell) => cell.rowIndex === rowIndex && cell.columnKey === columnKey
  );
  const decision = getCellEditDecision({
    role: snapshot.currentUser.role,
    userId: snapshot.currentUser.id,
    columnKey,
    columnPermissions: snapshot.columnPermissions,
    ownership,
    currentValue: previousCell?.formula ?? previousCell?.value ?? ""
  });

  if (!decision.allowed) {
    return { error: decision.reason ?? "You cannot edit this cell." };
  }

  const validation = validateAllowedValue({
    role: snapshot.currentUser.role,
    columnKey,
    nextValue: value,
    validationRules: snapshot.validationRules
  });

  if (!validation.valid) {
    return { error: validation.reason ?? "The value is not allowed." };
  }

  const normalized = normalizeCellInput(value);
  const editedCell: CellState = {
    rowIndex,
    columnKey,
    value: normalized.value,
    formula: normalized.formula,
    computedValue: normalized.value
  };
  const nextCellsWithoutComputed = upsertCell(cellsFromSnapshot(snapshot), editedCell);
  const nextCells = mergeRecalculatedCells(
    nextCellsWithoutComputed,
    recalculateCells(nextCellsWithoutComputed)
  );

  const violations = evaluateConditionalRules({
    cells: nextCells,
    rules: snapshot.conditionalRules
  });

  if (violations.length > 0) {
    return { error: violations[0].message };
  }

  const now = new Date().toISOString();
  const nextOwnerships =
    snapshot.currentUser.role === Role.MEMBER && !ownership
      ? [
          ...ownerships,
          {
            rowIndex,
            ownerId: snapshot.currentUser.id,
            ownerName: snapshot.currentUser.name,
            updatedAt: now
          }
        ]
      : ownerships;

  const nextSnapshotBase: Omit<SheetSnapshot, "rows"> = {
    ...snapshot,
    auditLogs: appendAuditLog(
      snapshot,
      snapshot.currentUser,
      rowIndex,
      columnKey,
      previousCell,
      nextCells.find((cell) => cell.rowIndex === rowIndex && cell.columnKey === columnKey) ??
        editedCell
    )
  };
  const nextRows = buildRowsFromCells(
    nextSnapshotBase,
    nextCells,
    nextOwnerships,
    formatsFromSnapshot(snapshot)
  );

  return {
    snapshot: {
      ...nextSnapshotBase,
      rows: nextRows
    }
  };
}

export function applyDemoCellFormatUpdate(
  snapshot: SheetSnapshot,
  input: {
    startRow: number;
    endRow: number;
    startColumnKey: ColumnKey;
    endColumnKey: ColumnKey;
    format?: CellFormatPatch;
    clear?: boolean;
  }
): { snapshot?: SheetSnapshot; error?: string } {
  if (snapshot.currentUser.role !== Role.ADMIN) {
    return { error: "Only admins can format cells." };
  }

  const startRow = Math.min(input.startRow, input.endRow);
  const endRow = Math.max(input.startRow, input.endRow);

  if (!isValidRowIndex(startRow) || !isValidRowIndex(endRow)) {
    return { error: "Rows must be between 1 and 1000." };
  }

  const startColumnIndex = COLUMN_KEYS.indexOf(input.startColumnKey);
  const endColumnIndex = COLUMN_KEYS.indexOf(input.endColumnKey);
  const targetColumns = COLUMN_KEYS.slice(
    Math.min(startColumnIndex, endColumnIndex),
    Math.max(startColumnIndex, endColumnIndex) + 1
  );

  if (targetColumns.length === 0) {
    return { error: "Select at least one column." };
  }

  const patch = normalizeFormatPatch(input.format ?? {});
  const nextRows = snapshot.rows.map((row) => {
    if (row.rowNumber < startRow || row.rowNumber > endRow) {
      return row;
    }

    const nextFormat = { ...row.__format };

    for (const columnKey of targetColumns) {
      nextFormat[columnKey] = input.clear
        ? createDefaultCellFormat()
        : mergeCellFormat(row.__format[columnKey], patch);
    }

    return {
      ...row,
      __format: nextFormat
    };
  });

  return {
    snapshot: {
      ...snapshot,
      rows: nextRows,
      auditLogs: [
        {
          id: `demo-format-${Date.now()}`,
          action: "CELL_FORMAT_UPDATED",
          actorName: snapshot.currentUser.name,
          rowIndex: startRow === endRow ? startRow : null,
          columnKey: targetColumns.length === 1 ? targetColumns[0] : null,
          message: `${snapshot.currentUser.name} formatted ${targetColumns[0]}${startRow}:${
            targetColumns[targetColumns.length - 1]
          }${endRow} in local demo mode.`,
          createdAt: new Date().toISOString()
        },
        ...snapshot.auditLogs
      ].slice(0, 30)
    }
  };
}
