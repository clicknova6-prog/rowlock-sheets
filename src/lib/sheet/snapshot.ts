import { Role } from "@/generated/prisma/enums";
import { COLUMN_KEYS, MAX_ROWS, assertColumnKey, getCellKey } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  DEFAULT_SHEET_VIEW_SETTING,
  createDefaultCellFormat,
  normalizeHexColor,
  normalizeHorizontalAlign,
  normalizeSheetFontSize
} from "./formatting";
import { getCellEditDecision } from "./permissions";
import type {
  Actor,
  AuditLogState,
  CellFormatEntryState,
  CellFormatState,
  CellState,
  ColumnPermissionState,
  ConditionalRuleState,
  RowOwnershipState,
  SheetGridRow,
  SheetSnapshot,
  ValidationRuleState
} from "./types";

function stringArrayFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item : String(item)))
    .filter(Boolean);
}

export function mapValidationRule(rule: {
  id: string;
  columnKey: string;
  name: string;
  allowedValues: unknown;
  enabled: boolean;
}): ValidationRuleState {
  return {
    id: rule.id,
    columnKey: assertColumnKey(rule.columnKey),
    name: rule.name,
    allowedValues: stringArrayFromJson(rule.allowedValues),
    enabled: rule.enabled
  };
}

export function mapConditionalRule(rule: {
  id: string;
  name: string;
  description: string | null;
  limitCount: number;
  enabled: boolean;
  conditions: Array<{
    id: string;
    columnKey: string;
    operator: ConditionalRuleState["conditions"][number]["operator"];
    values: unknown;
  }>;
}): ConditionalRuleState {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    limitCount: rule.limitCount,
    enabled: rule.enabled,
    conditions: rule.conditions.map((condition) => ({
      id: condition.id,
      columnKey: assertColumnKey(condition.columnKey),
      operator: condition.operator,
      values: stringArrayFromJson(condition.values)
    }))
  };
}

function buildEmptyColumnRecord(): Record<(typeof COLUMN_KEYS)[number], string> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, ""])) as Record<
    (typeof COLUMN_KEYS)[number],
    string
  >;
}

function buildBooleanColumnRecord(): Record<(typeof COLUMN_KEYS)[number], boolean> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, false])) as Record<
    (typeof COLUMN_KEYS)[number],
    boolean
  >;
}

function buildNullableColumnRecord(): Record<(typeof COLUMN_KEYS)[number], string | null> {
  return Object.fromEntries(COLUMN_KEYS.map((columnKey) => [columnKey, null])) as Record<
    (typeof COLUMN_KEYS)[number],
    string | null
  >;
}

function buildFormatColumnRecord(): Record<(typeof COLUMN_KEYS)[number], CellFormatState> {
  return Object.fromEntries(
    COLUMN_KEYS.map((columnKey) => [columnKey, createDefaultCellFormat()])
  ) as Record<(typeof COLUMN_KEYS)[number], CellFormatState>;
}

function getDuplicateHighlightedRows(
  cellLookup: Map<string, CellState>,
  permissions: ColumnPermissionState[]
): Set<number> {
  const highlightedRows = new Set<number>();
  const duplicateColumns = permissions
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

export async function getDefaultSheetId(): Promise<string | null> {
  const sheet = await prisma.sheet.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });

  return sheet?.id ?? null;
}

export async function getSheetSnapshot(
  sheetId: string,
  currentUser: Actor
): Promise<SheetSnapshot> {
  const [
    sheet,
    cells,
    columnPermissions,
    ownerships,
    sheetRows,
    cellFormats,
    viewSetting,
    validationRules,
    conditionalRules,
    auditLogs
  ] = await Promise.all([
    prisma.sheet.findUniqueOrThrow({
      where: { id: sheetId },
      select: { id: true, name: true }
    }),
    prisma.cell.findMany({
      where: { sheetId },
      select: {
        rowIndex: true,
        columnKey: true,
        value: true,
        formula: true,
        computedValue: true
      }
    }),
    prisma.columnPermission.findMany({
      where: { sheetId },
      select: {
        columnKey: true,
        editableByMember: true,
        claimRowOnEdit: true,
        memberWriteOnce: true,
        duplicateHighlight: true
      }
    }),
    prisma.rowOwnership.findMany({
      where: { sheetId },
      include: { owner: { select: { id: true, name: true } } }
    }),
    prisma.sheetRow.findMany({
      where: { sheetId },
      include: { lastEditedBy: { select: { name: true } } }
    }),
    prisma.cellFormat.findMany({
      where: { sheetId },
      select: {
        rowIndex: true,
        columnKey: true,
        bold: true,
        italic: true,
        underline: true,
        textColor: true,
        backgroundColor: true,
        horizontalAlign: true
      }
    }),
    prisma.sheetViewSetting.findUnique({
      where: { sheetId },
      select: {
        alternateRowColors: true,
        alternateOddColor: true,
        alternateEvenColor: true,
        fontSize: true
      }
    }),
    prisma.validationRule.findMany({
      where: { sheetId },
      orderBy: [{ columnKey: "asc" }, { createdAt: "asc" }]
    }),
    prisma.conditionalRule.findMany({
      where: { sheetId },
      include: { conditions: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" }
    }),
    prisma.auditLog.findMany({
      where: { sheetId },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 30
    })
  ]);

  const permissions: ColumnPermissionState[] = COLUMN_KEYS.map((columnKey) => {
    const permission = columnPermissions.find((item) => item.columnKey === columnKey);
    return {
      columnKey,
      editableByMember: permission?.editableByMember ?? false,
      claimRowOnEdit: permission?.claimRowOnEdit ?? false,
      memberWriteOnce: permission?.memberWriteOnce ?? false,
      duplicateHighlight: permission?.duplicateHighlight ?? false
    };
  });

  const cellLookup = new Map<string, CellState>();
  for (const cell of cells) {
    const columnKey = assertColumnKey(cell.columnKey);
    cellLookup.set(getCellKey(cell.rowIndex, columnKey), {
      rowIndex: cell.rowIndex,
      columnKey,
      value: cell.value,
      formula: cell.formula,
      computedValue: cell.computedValue
    });
  }

  const formatLookup = new Map<string, CellFormatEntryState>();
  for (const format of cellFormats) {
    const columnKey = assertColumnKey(format.columnKey);
    formatLookup.set(getCellKey(format.rowIndex, columnKey), {
      rowIndex: format.rowIndex,
      columnKey,
      bold: format.bold,
      italic: format.italic,
      underline: format.underline,
      textColor: normalizeHexColor(format.textColor),
      backgroundColor: normalizeHexColor(format.backgroundColor),
      horizontalAlign: normalizeHorizontalAlign(format.horizontalAlign)
    });
  }

  const ownershipLookup = new Map<number, RowOwnershipState>();
  for (const ownership of ownerships) {
    ownershipLookup.set(ownership.rowIndex, {
      rowIndex: ownership.rowIndex,
      ownerId: ownership.ownerId,
      ownerName: ownership.owner.name,
      updatedAt: ownership.updatedAt.toISOString()
    });
  }

  const duplicateHighlightedRows = getDuplicateHighlightedRows(cellLookup, permissions);

  const sheetRowLookup = new Map(
    sheetRows.map((row) => [
      row.rowIndex,
      {
        lastEditedBy: row.lastEditedBy?.name ?? null,
        updatedAt: row.updatedAt.toISOString()
      }
    ])
  );

  const rows: SheetGridRow[] = [];

  for (let rowIndex = 1; rowIndex <= MAX_ROWS; rowIndex += 1) {
    const values = buildEmptyColumnRecord();
    const computed = buildEmptyColumnRecord();
    const formulas = buildBooleanColumnRecord();
    const editable = buildBooleanColumnRecord();
    const lockReason = buildNullableColumnRecord();
    const format = buildFormatColumnRecord();
    const ownership = ownershipLookup.get(rowIndex) ?? null;

    for (const columnKey of COLUMN_KEYS) {
      const cell = cellLookup.get(getCellKey(rowIndex, columnKey));
      const cellFormat = formatLookup.get(getCellKey(rowIndex, columnKey));
      values[columnKey] = cell?.formula ?? cell?.value ?? "";
      computed[columnKey] = cell?.computedValue ?? cell?.value ?? "";
      formulas[columnKey] = Boolean(cell?.formula);
      format[columnKey] = cellFormat ?? createDefaultCellFormat();

      const decision = getCellEditDecision({
        role: currentUser.role,
        userId: currentUser.id,
        columnKey,
        columnPermissions: permissions,
        ownership,
        currentValue: values[columnKey]
      });

      editable[columnKey] = decision.allowed;
      lockReason[columnKey] = decision.reason;
    }

    const rowMeta = sheetRowLookup.get(rowIndex);

    rows.push({
      rowNumber: rowIndex,
      ownerId: ownership?.ownerId ?? null,
      ownerName: ownership?.ownerName ?? null,
      lastEditedBy: rowMeta?.lastEditedBy ?? null,
      updatedAt: rowMeta?.updatedAt ?? ownership?.updatedAt ?? null,
      __computed: computed,
      __formula: formulas,
      __editable: editable,
      __lockReason: lockReason,
      __format: format,
      __duplicateHighlight: duplicateHighlightedRows.has(rowIndex),
      ...values
    });
  }

  const mappedAuditLogs: AuditLogState[] = auditLogs.map((log) => ({
    id: log.id,
    action: log.action,
    actorName: log.actor?.name ?? null,
    rowIndex: log.rowIndex,
    columnKey: log.columnKey,
    message: log.message,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString()
  }));

  return {
    currentUser,
    sheet,
    columns: [...COLUMN_KEYS],
    rows,
    viewSetting: {
      alternateRowColors:
        viewSetting?.alternateRowColors ?? DEFAULT_SHEET_VIEW_SETTING.alternateRowColors,
      alternateOddColor:
        normalizeHexColor(viewSetting?.alternateOddColor) ??
        DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
      alternateEvenColor:
        normalizeHexColor(viewSetting?.alternateEvenColor) ??
        DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
      fontSize: normalizeSheetFontSize(viewSetting?.fontSize)
    },
    columnPermissions: permissions,
    validationRules: validationRules.map(mapValidationRule),
    conditionalRules: conditionalRules.map(mapConditionalRule),
    auditLogs: mappedAuditLogs
  };
}

export async function getFirstSheetSnapshot(currentUser: Actor): Promise<SheetSnapshot | null> {
  const sheetId = await getDefaultSheetId();

  if (!sheetId) {
    return null;
  }

  return getSheetSnapshot(sheetId, currentUser);
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === Role.ADMIN;
}
