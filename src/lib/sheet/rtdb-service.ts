import { randomUUID } from "node:crypto";
import { AuditAction, Role, RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import {
  COLUMN_KEYS,
  MAX_ROWS,
  assertColumnKey,
  getCellKey,
  isValidRowIndex
} from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import { firebaseAdminRealtimeDb } from "@/lib/firebase/admin";
import { buildRowsFromCells } from "./demo-engine";
import { SheetRuleError } from "./errors";
import {
  createDefaultCellFormat,
  DEFAULT_SHEET_VIEW_SETTING,
  isDefaultCellFormat,
  mergeCellFormat,
  normalizeFormatPatch,
  normalizeHexColor,
  normalizeHorizontalAlign,
  normalizeSheetColumnWidths,
  normalizeSheetCondensedView,
  normalizeSheetFrozenHeaderColumnKey,
  normalizeSheetFrozenHeaderRowIndex,
  normalizeSheetFontSize
} from "./formatting";
import { isFormula, mergeRecalculatedCells, normalizeCellInput, recalculateCells } from "./formulas";
import { getCellEditDecision } from "./permissions";
import { getRowsForPersistedCellUpdates } from "./row-payloads";
import { evaluateConditionalRules } from "./rules";
import { validateAllowedValue } from "./validation";
import type {
  Actor,
  AuditLogState,
  CellFormatEntryState,
  CellFormatState,
  CellHistoryEntryState,
  CellState,
  ColumnPermissionState,
  ConditionalRuleState,
  RowOwnershipState,
  SheetSnapshot,
  SheetViewSettingState,
  ValidationRuleState
} from "./types";
import type {
  BulkUpdateCellInput,
  ClaimRowForEditInput,
  GetCellHistoryInput,
  UpdateCellFormatsInput,
  UpdateCellInput,
  UpdateColumnRuleSettingsInput,
  UpdateSheetViewSettingsInput
} from "./service";

const RTDB_SCHEMA_VERSION = 1;
const FORBIDDEN_RTDB_KEY_CHARS = /[.#$/[\]]/g;
const DETAILED_BULK_AUDIT_LIMIT = 100;
const CELL_HISTORY_LIMIT = 100;

interface RealtimeSheetData {
  schemaVersion?: unknown;
  metadata?: unknown;
  columns?: unknown;
  cells?: unknown;
  rowMeta?: unknown;
  ownership?: unknown;
  formats?: unknown;
  permissions?: unknown;
  viewSetting?: unknown;
  validationRules?: unknown;
  conditionalRules?: unknown;
  audit?: unknown;
  cellHistory?: unknown;
}

interface RealtimeRowMeta {
  lastEditedBy: string | null;
  updatedAt: string | null;
}

interface ParsedRealtimeSheet {
  snapshot: SheetSnapshot;
  cells: CellState[];
  ownerships: RowOwnershipState[];
  formats: CellFormatEntryState[];
  rowMeta: Map<number, RealtimeRowMeta>;
}

interface AppliedRealtimeCellUpdates {
  snapshot: SheetSnapshot;
  cells: CellState[];
  cellHistoryLogs: AuditLogState[];
}

interface WriteRealtimeRowsOptions {
  includeCells?: boolean;
  cellStates?: CellState[];
  cellHistoryLogs?: AuditLogState[];
}

function safeKey(value: string | number): string {
  return String(value).replace(FORBIDDEN_RTDB_KEY_CHARS, "_");
}

function cleanForRealtimeDatabase<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function stringArrayFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeDelayMinutes(value: unknown): number {
  const minutes = Number.parseInt(String(value ?? "0"), 10);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }

  return Math.min(1440, minutes);
}

function normalizeRowIndexes(rowIndexes: number[]): number[] {
  const normalized = [...new Set(rowIndexes)].sort((a, b) => a - b);

  if (normalized.length === 0) {
    throw new SheetRuleError("Enter at least one row number.");
  }

  for (const rowIndex of normalized) {
    if (!isValidRowIndex(rowIndex)) {
      throw new SheetRuleError("Rows must be between 1 and 1000.");
    }
  }

  return normalized;
}

function normalizeMatchHighlightTerms(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 500);
}

function getMetadataString(metadata: unknown, key: string): string | null {
  const record = asRecord(metadata);
  const value = record[key];

  return value === null || value === undefined ? null : String(value);
}

function getCellRawValue(cell: CellState | undefined): string {
  const formula = cell?.formula && isFormula(cell.formula) ? cell.formula : null;
  return formula ?? cell?.value ?? "";
}

function hasClaimableValue(cell: CellState): boolean {
  return getCellRawValue(cell).trim().length > 0;
}

function upsertEditedCells(cells: CellState[], editedCells: CellState[]): CellState[] {
  const lookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));

  for (const cell of editedCells) {
    lookup.set(getCellKey(cell.rowIndex, cell.columnKey), cell);
  }

  return [...lookup.values()];
}

function normalizePermission(columnKey: ColumnKey, value: unknown): ColumnPermissionState {
  const record = asRecord(value);
  const editableByMember = asBoolean(record.editableByMember);
  const delayMinutes = normalizeDelayMinutes(record.memberEditDelayMinutes);
  const delaySource =
    typeof record.memberEditDelaySourceColumnKey === "string" &&
    COLUMN_KEYS.includes(record.memberEditDelaySourceColumnKey as ColumnKey) &&
    record.memberEditDelaySourceColumnKey !== columnKey &&
    delayMinutes > 0
      ? (record.memberEditDelaySourceColumnKey as ColumnKey)
      : null;

  return {
    columnKey,
    editableByMember,
    claimRowOnEdit: editableByMember && asBoolean(record.claimRowOnEdit),
    memberWriteOnce: asBoolean(record.memberWriteOnce),
    memberEditDelaySourceColumnKey: delaySource,
    memberEditDelayMinutes: delaySource ? delayMinutes : 0,
    duplicateHighlight: asBoolean(record.duplicateHighlight),
    matchHighlightTerms: stringArrayFromValue(record.matchHighlightTerms)
  };
}

function normalizeViewSetting(value: unknown): SheetViewSettingState {
  const record = asRecord(value);

  return {
    alternateRowColors: asBoolean(
      record.alternateRowColors,
      DEFAULT_SHEET_VIEW_SETTING.alternateRowColors
    ),
    alternateOddColor:
      normalizeHexColor(record.alternateOddColor) ?? DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
    alternateEvenColor:
      normalizeHexColor(record.alternateEvenColor) ?? DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
    fontSize: normalizeSheetFontSize(record.fontSize),
    columnWidths: normalizeSheetColumnWidths(record.columnWidths),
    condensedView: normalizeSheetCondensedView(record.condensedView),
    frozenHeaderRowIndex: normalizeSheetFrozenHeaderRowIndex(record.frozenHeaderRowIndex),
    frozenHeaderColumnKey: normalizeSheetFrozenHeaderColumnKey(record.frozenHeaderColumnKey),
    memberEditLockAt: asNullableString(record.memberEditLockAt)
  };
}

function normalizeCellFormat(value: unknown): CellFormatState {
  const record = asRecord(value);

  return {
    bold: asBoolean(record.bold),
    italic: asBoolean(record.italic),
    underline: asBoolean(record.underline),
    textColor: normalizeHexColor(record.textColor),
    backgroundColor: normalizeHexColor(record.backgroundColor),
    horizontalAlign: normalizeHorizontalAlign(record.horizontalAlign)
  };
}

function normalizeValidationRule(id: string, value: unknown): ValidationRuleState | null {
  const record = asRecord(value);
  const rawColumnKey = asString(record.columnKey);

  if (!COLUMN_KEYS.includes(rawColumnKey as ColumnKey)) {
    return null;
  }

  return {
    id: asString(record.id, id),
    columnKey: rawColumnKey as ColumnKey,
    name: asString(record.name, `Allowed values for ${rawColumnKey}`),
    allowedValues: stringArrayFromValue(record.allowedValues),
    enabled: asBoolean(record.enabled, true)
  };
}

function normalizeRuleOperator(value: unknown): RuleOperator {
  return Object.values(RuleOperator).includes(value as RuleOperator)
    ? (value as RuleOperator)
    : RuleOperator.EQUALS;
}

function normalizeRuleJoinOperator(value: unknown): RuleJoinOperator {
  return Object.values(RuleJoinOperator).includes(value as RuleJoinOperator)
    ? (value as RuleJoinOperator)
    : RuleJoinOperator.AND;
}

function normalizeConditionalRule(id: string, value: unknown): ConditionalRuleState | null {
  const record = asRecord(value);
  const conditions = Object.entries(asRecord(record.conditions))
    .map(([conditionId, conditionValue], index) => {
      const condition = asRecord(conditionValue);
      const rawColumnKey = asString(condition.columnKey);

      if (!COLUMN_KEYS.includes(rawColumnKey as ColumnKey)) {
        return null;
      }

      return {
        id: asString(condition.id, conditionId),
        columnKey: rawColumnKey as ColumnKey,
        operator: normalizeRuleOperator(condition.operator),
        joinOperator:
          index === 0 ? RuleJoinOperator.AND : normalizeRuleJoinOperator(condition.joinOperator),
        values: stringArrayFromValue(condition.values)
      };
    })
    .filter(Boolean) as ConditionalRuleState["conditions"];

  return {
    id: asString(record.id, id),
    name: asString(record.name, "Untitled rule"),
    description: asNullableString(record.description),
    limitCount: Math.max(1, Math.round(asNumber(record.limitCount, 1))),
    enabled: asBoolean(record.enabled, true),
    conditions
  };
}

function parseAuditLogs(value: unknown, limit = 30): AuditLogState[] {
  return Object.entries(asRecord(value))
    .map(([id, auditValue]) => {
      const record = asRecord(auditValue);
      const createdAt = asString(record.createdAt, nowIso());

      return {
        id,
        action: asString(record.action),
        actorName: asNullableString(record.actorName),
        rowIndex:
          record.rowIndex === null || record.rowIndex === undefined
            ? null
            : Math.round(asNumber(record.rowIndex)),
        columnKey: asNullableString(record.columnKey),
        message: asString(record.message),
        metadata: record.metadata ?? null,
        createdAt
      };
    })
    .filter((log) => log.action && log.message)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

function getLogTimestamp(log: AuditLogState): number {
  const timestamp = Date.parse(log.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getCellTimestamp(cell: CellState | undefined): number {
  if (!cell?.updatedAt) {
    return 0;
  }

  const timestamp = new Date(cell.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function recoverCellFromAuditLog(
  cellLookup: Map<string, CellState>,
  log: AuditLogState,
  options: { respectExistingTimestamp?: boolean } = {}
): void {
  if (
    log.action !== AuditAction.CELL_UPDATED ||
    !isValidRowIndex(log.rowIndex ?? 0) ||
    !COLUMN_KEYS.includes(log.columnKey as ColumnKey)
  ) {
    return;
  }

  const rowIndex = log.rowIndex as number;
  const columnKey = log.columnKey as ColumnKey;
  const cellKey = getCellKey(rowIndex, columnKey);
  const existingCell = cellLookup.get(cellKey);

  if (getCellRawValue(existingCell).trim()) {
    return;
  }

  if (
    options.respectExistingTimestamp !== false &&
    getCellTimestamp(existingCell) > getLogTimestamp(log)
  ) {
    return;
  }

  const metadata = asRecord(log.metadata);
  const rawFormula = asNullableString(metadata.formula);
  const formula = rawFormula && isFormula(rawFormula) ? rawFormula : null;
  const value = formula ? "" : asString(metadata.value);
  const computedValue = formula
    ? asString(metadata.computedValue, value)
    : asString(metadata.computedValue) || value;

  if (!formula && !value && !computedValue && !existingCell?.computedValue?.trim()) {
    return;
  }

  cellLookup.set(cellKey, {
    rowIndex,
    columnKey,
    value,
    formula,
    computedValue,
    updatedAt: log.createdAt
  });
}

function recoverCellsFromCellHistory(
  cellLookup: Map<string, CellState>,
  cellHistory: unknown
): void {
  for (const [rawRowIndex, columns] of Object.entries(asRecord(cellHistory))) {
    const rowIndex = Number.parseInt(rawRowIndex, 10);

    if (!isValidRowIndex(rowIndex)) {
      continue;
    }

    for (const [rawColumnKey, logs] of Object.entries(asRecord(columns))) {
      if (!COLUMN_KEYS.includes(rawColumnKey as ColumnKey)) {
        continue;
      }

      const [latestLog] = parseAuditLogs(logs, 1);

      if (latestLog) {
        recoverCellFromAuditLog(cellLookup, latestLog, { respectExistingTimestamp: false });
      }
    }
  }
}

function parseRealtimeSheet(
  sheetId: string,
  currentUser: Actor,
  data: RealtimeSheetData
): ParsedRealtimeSheet {
  const metadata = asRecord(data.metadata);
  const sheet = {
    id: sheetId,
    name: asString(metadata.name, "Operations Tracker")
  };
  const permissionsRecord = asRecord(data.permissions);
  const columnPermissions = COLUMN_KEYS.map((columnKey) =>
    normalizePermission(columnKey, permissionsRecord[columnKey])
  );
  const viewSetting = normalizeViewSetting(data.viewSetting);
  const validationRules = Object.entries(asRecord(data.validationRules))
    .map(([id, value]) => normalizeValidationRule(id, value))
    .filter(Boolean) as ValidationRuleState[];
  const conditionalRules = Object.entries(asRecord(data.conditionalRules))
    .map(([id, value]) => normalizeConditionalRule(id, value))
    .filter(Boolean) as ConditionalRuleState[];
  const auditLogs = parseAuditLogs(data.audit);
  const cells: CellState[] = [];
  const cellRows = asRecord(data.cells);

  for (const [rawRowIndex, columns] of Object.entries(cellRows)) {
    const rowIndex = Number.parseInt(rawRowIndex, 10);

    if (!isValidRowIndex(rowIndex)) {
      continue;
    }

    for (const columnKey of COLUMN_KEYS) {
      const cell = asRecord(asRecord(columns)[columnKey]);
      const value = asString(cell.value);
      const rawFormula = asNullableString(cell.formula);
      const formula = rawFormula && isFormula(rawFormula) ? rawFormula : null;
      const computedValue = formula
        ? asString(cell.computedValue, value)
        : asString(cell.computedValue) || value;
      const updatedAt = asNullableString(cell.updatedAt);

      if (value || formula || computedValue || updatedAt) {
        cells.push({
          rowIndex,
          columnKey,
          value,
          formula,
          computedValue,
          updatedAt
        });
      }
    }
  }
  const cellLookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));
  const seenAuditCells = new Set<string>();

  for (const log of auditLogs) {
    if (
      log.action !== AuditAction.CELL_UPDATED ||
      !isValidRowIndex(log.rowIndex ?? 0) ||
      !COLUMN_KEYS.includes(log.columnKey as ColumnKey)
    ) {
      continue;
    }

    const cellKey = getCellKey(log.rowIndex as number, log.columnKey as ColumnKey);

    if (seenAuditCells.has(cellKey)) {
      continue;
    }

    seenAuditCells.add(cellKey);
    recoverCellFromAuditLog(cellLookup, log);
  }

  recoverCellsFromCellHistory(cellLookup, data.cellHistory);

  const parsedCells = [...cellLookup.values()];

  const ownerships: RowOwnershipState[] = Object.entries(asRecord(data.ownership))
    .map(([rawRowIndex, ownershipValue]) => {
      const rowIndex = Number.parseInt(rawRowIndex, 10);
      const ownership = asRecord(ownershipValue);
      const ownerId = asString(ownership.ownerId);

      if (!isValidRowIndex(rowIndex) || !ownerId) {
        return null;
      }

      return {
        rowIndex,
        ownerId,
        ownerName: asNullableString(ownership.ownerName),
        updatedAt: asNullableString(ownership.updatedAt)
      };
    })
    .filter(Boolean) as RowOwnershipState[];

  const formats: CellFormatEntryState[] = [];

  for (const [rawRowIndex, columns] of Object.entries(asRecord(data.formats))) {
    const rowIndex = Number.parseInt(rawRowIndex, 10);

    if (!isValidRowIndex(rowIndex)) {
      continue;
    }

    for (const [rawColumnKey, formatValue] of Object.entries(asRecord(columns))) {
      if (!COLUMN_KEYS.includes(rawColumnKey as ColumnKey)) {
        continue;
      }

      const format = normalizeCellFormat(formatValue);

      if (!isDefaultCellFormat(format)) {
        formats.push({
          rowIndex,
          columnKey: rawColumnKey as ColumnKey,
          ...format
        });
      }
    }
  }

  const rowMeta = new Map<number, RealtimeRowMeta>();

  for (const [rawRowIndex, metaValue] of Object.entries(asRecord(data.rowMeta))) {
    const rowIndex = Number.parseInt(rawRowIndex, 10);

    if (!isValidRowIndex(rowIndex)) {
      continue;
    }

    const meta = asRecord(metaValue);
    rowMeta.set(rowIndex, {
      lastEditedBy: asNullableString(meta.lastEditedBy),
      updatedAt: asNullableString(meta.updatedAt)
    });
  }

  const snapshotBase: Omit<SheetSnapshot, "rows"> = {
    currentUser,
    sheet,
    columns: [...COLUMN_KEYS],
    viewSetting,
    columnPermissions,
    validationRules,
    conditionalRules,
    auditLogs
  };

  return {
    snapshot: {
      ...snapshotBase,
      rows: buildRowsFromCells(snapshotBase, parsedCells, ownerships, formats, rowMeta)
    },
    cells: parsedCells,
    ownerships,
    formats,
    rowMeta
  };
}

function serializeCellFormat(format: CellFormatState): CellFormatState {
  return {
    bold: format.bold,
    italic: format.italic,
    underline: format.underline,
    textColor: format.textColor,
    backgroundColor: format.backgroundColor,
    horizontalAlign: format.horizontalAlign
  };
}

function serializeCellUpdatedAt(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(value);
}

function serializeCellState(cell: CellState): Record<string, unknown> {
  const formula = cell.formula && isFormula(cell.formula) ? cell.formula : null;
  const value = formula ? "" : cell.value || cell.computedValue || "";

  return {
    value,
    formula,
    computedValue: formula ? cell.computedValue ?? value : cell.computedValue || value,
    updatedAt: serializeCellUpdatedAt(cell.updatedAt)
  };
}

function serializeRowCells(row: SheetSnapshot["rows"][number]): Record<ColumnKey, unknown> {
  return Object.fromEntries(
    COLUMN_KEYS.map((columnKey) => {
      const rawValue = String(row[columnKey] ?? "");
      const formula = row.__formula[columnKey] && isFormula(rawValue) ? rawValue : null;
      return [
        columnKey,
        {
          value: formula ? "" : rawValue,
          formula,
          computedValue: formula
            ? row.__computed[columnKey] ?? rawValue
            : row.__computed[columnKey] || rawValue,
          updatedAt: row.__cellUpdatedAt[columnKey] ?? null
        }
      ];
    })
  ) as Record<ColumnKey, unknown>;
}

function serializeRowFormats(row: SheetSnapshot["rows"][number]): Record<string, unknown> | null {
  const formats = Object.fromEntries(
    COLUMN_KEYS.flatMap((columnKey) => {
      const format = row.__format[columnKey];
      return isDefaultCellFormat(format) ? [] : [[columnKey, serializeCellFormat(format)]];
    })
  );

  return Object.keys(formats).length > 0 ? formats : null;
}

function serializeRowMeta(row: SheetSnapshot["rows"][number]): Record<string, unknown> {
  return {
    lastEditedBy: row.lastEditedBy,
    updatedAt: row.updatedAt,
    duplicateHighlight: row.__duplicateHighlight,
    matchHighlight: row.__matchHighlight
  };
}

function serializeRowOwnership(row: SheetSnapshot["rows"][number]): Record<string, unknown> | null {
  return row.ownerId
    ? {
        ownerId: row.ownerId,
        ownerName: row.ownerName,
        updatedAt: row.updatedAt
      }
    : null;
}

function serializeAuditLog(log: AuditLogState): Omit<AuditLogState, "id"> {
  return {
    action: log.action,
    actorName: log.actorName,
    rowIndex: log.rowIndex,
    columnKey: log.columnKey,
    message: log.message,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt
  };
}

function serializeAuditLogs(auditLogs: AuditLogState[]): Record<string, Omit<AuditLogState, "id">> {
  return Object.fromEntries(
    auditLogs.slice(0, 30).map((log) => [safeKey(log.id), serializeAuditLog(log)])
  );
}

function serializeSnapshot(snapshot: SheetSnapshot): RealtimeSheetData {
  return cleanForRealtimeDatabase({
    schemaVersion: RTDB_SCHEMA_VERSION,
    metadata: {
      id: snapshot.sheet.id,
      name: snapshot.sheet.name,
      sourceOfTruth: "rtdb",
      updatedAt: nowIso()
    },
    columns: snapshot.columns,
    permissions: Object.fromEntries(
      snapshot.columnPermissions.map((permission) => [permission.columnKey, permission])
    ),
    viewSetting: snapshot.viewSetting,
    validationRules: Object.fromEntries(
      snapshot.validationRules.map((rule, index) => [
        safeKey(rule.id ?? `${rule.columnKey}-${index}`),
        rule
      ])
    ),
    conditionalRules: Object.fromEntries(
      snapshot.conditionalRules.map((rule) => [safeKey(rule.id), rule])
    ),
    cells: Object.fromEntries(
      snapshot.rows.map((row) => [safeKey(row.rowNumber), serializeRowCells(row)])
    ),
    rowMeta: Object.fromEntries(
      snapshot.rows.map((row) => [safeKey(row.rowNumber), serializeRowMeta(row)])
    ),
    ownership: Object.fromEntries(
      snapshot.rows.flatMap((row) =>
        row.ownerId
          ? [[safeKey(row.rowNumber), serializeRowOwnership(row)]]
          : []
      )
    ),
    formats: Object.fromEntries(
      snapshot.rows.flatMap((row) => {
        const formats = serializeRowFormats(row);
        return formats ? [[safeKey(row.rowNumber), formats]] : [];
      })
    ),
    audit: serializeAuditLogs(snapshot.auditLogs)
  });
}

async function writeRealtimeSnapshot(snapshot: SheetSnapshot): Promise<void> {
  await firebaseAdminRealtimeDb
    .ref(`sheets/${safeKey(snapshot.sheet.id)}`)
    .set(serializeSnapshot(snapshot));
}

async function writeRealtimeRows(
  snapshot: SheetSnapshot,
  rows: SheetSnapshot["rows"],
  options: WriteRealtimeRowsOptions = {}
): Promise<void> {
  const cellStates = options.cellStates ?? [];
  const cellHistoryLogs = options.cellHistoryLogs ?? [];

  if (rows.length === 0 && cellStates.length === 0 && cellHistoryLogs.length === 0) {
    return;
  }

  const sheetPath = `sheets/${safeKey(snapshot.sheet.id)}`;
  const updates: Record<string, unknown> = {
    [`${sheetPath}/metadata/sourceOfTruth`]: "rtdb",
    [`${sheetPath}/metadata/updatedAt`]: nowIso(),
    [`${sheetPath}/audit`]: serializeAuditLogs(snapshot.auditLogs)
  };

  for (const row of rows) {
    const rowKey = safeKey(row.rowNumber);

    if (options.includeCells !== false) {
      updates[`${sheetPath}/cells/${rowKey}`] = serializeRowCells(row);
    }

    updates[`${sheetPath}/rowMeta/${rowKey}`] = serializeRowMeta(row);
    updates[`${sheetPath}/ownership/${rowKey}`] = serializeRowOwnership(row);
    updates[`${sheetPath}/formats/${rowKey}`] = serializeRowFormats(row);
  }

  for (const cell of cellStates) {
    if (!isValidRowIndex(cell.rowIndex) || !COLUMN_KEYS.includes(cell.columnKey)) {
      continue;
    }

    updates[`${sheetPath}/cells/${safeKey(cell.rowIndex)}/${cell.columnKey}`] =
      serializeCellState(cell);
  }

  for (const log of cellHistoryLogs) {
    if (
      log.rowIndex === null ||
      log.columnKey === null ||
      !isValidRowIndex(log.rowIndex) ||
      !COLUMN_KEYS.includes(log.columnKey as ColumnKey)
    ) {
      continue;
    }

    updates[
      `${sheetPath}/cellHistory/${safeKey(log.rowIndex)}/${log.columnKey}/${safeKey(log.id)}`
    ] = serializeAuditLog(log);
  }

  await firebaseAdminRealtimeDb.ref().update(cleanForRealtimeDatabase(updates));
}

function selectRowsByIndexes(
  snapshot: SheetSnapshot,
  rowIndexes: Iterable<number>
): SheetSnapshot["rows"] {
  const wantedRows = new Set(rowIndexes);
  return snapshot.rows.filter((row) => wantedRows.has(row.rowNumber));
}

function selectCellsForPersistedUpdates(
  cells: CellState[],
  rows: SheetSnapshot["rows"],
  updates: Array<{ rowIndex: number; columnKey: ColumnKey }>
): CellState[] {
  const editedCells = new Set(
    updates.map((update) => getCellKey(update.rowIndex, update.columnKey))
  );
  const returnedRows = new Set(rows.map((row) => row.rowNumber));

  return cells.filter((cell) => {
    if (editedCells.has(getCellKey(cell.rowIndex, cell.columnKey))) {
      return true;
    }

    return returnedRows.has(cell.rowIndex) && Boolean(cell.formula && isFormula(cell.formula));
  });
}

function createAuditLogs(logs: Omit<AuditLogState, "id" | "createdAt">[]): AuditLogState[] {
  const createdAt = nowIso();

  return logs.map((log) => ({
    id: createId("audit"),
    createdAt,
    ...log
  }));
}

function appendAuditLogs(snapshot: SheetSnapshot, logs: Omit<AuditLogState, "id" | "createdAt">[]): AuditLogState[] {
  return [...createAuditLogs(logs), ...snapshot.auditLogs].slice(0, 30);
}

function buildSnapshotFromParts(input: {
  snapshot: SheetSnapshot;
  cells: CellState[];
  ownerships: RowOwnershipState[];
  formats: CellFormatEntryState[];
  rowMeta: Map<number, RealtimeRowMeta>;
  columnPermissions?: ColumnPermissionState[];
  viewSetting?: SheetViewSettingState;
  validationRules?: ValidationRuleState[];
  conditionalRules?: ConditionalRuleState[];
  auditLogs?: AuditLogState[];
}): SheetSnapshot {
  const base: Omit<SheetSnapshot, "rows"> = {
    currentUser: input.snapshot.currentUser,
    sheet: input.snapshot.sheet,
    columns: input.snapshot.columns,
    viewSetting: input.viewSetting ?? input.snapshot.viewSetting,
    columnPermissions: input.columnPermissions ?? input.snapshot.columnPermissions,
    validationRules: input.validationRules ?? input.snapshot.validationRules,
    conditionalRules: input.conditionalRules ?? input.snapshot.conditionalRules,
    auditLogs: input.auditLogs ?? input.snapshot.auditLogs
  };

  return {
    ...base,
    rows: buildRowsFromCells(
      base,
      input.cells,
      input.ownerships,
      input.formats,
      input.rowMeta
    )
  };
}

function getDelaySourceCellForDecision(
  columnPermissions: ColumnPermissionState[],
  rowIndex: number,
  columnKey: ColumnKey,
  cellLookup: Map<string, CellState>
): CellState | null {
  const permission = columnPermissions.find((item) => item.columnKey === columnKey);

  return permission?.memberEditDelaySourceColumnKey
    ? cellLookup.get(getCellKey(rowIndex, permission.memberEditDelaySourceColumnKey)) ?? null
    : null;
}

async function readRealtimeSheet(sheetId: string, actor: Actor): Promise<ParsedRealtimeSheet> {
  const sheetSnapshot = await firebaseAdminRealtimeDb.ref(`sheets/${safeKey(sheetId)}`).get();

  if (!sheetSnapshot.exists()) {
    throw new SheetRuleError("Sheet was not found in Realtime Database.", 404);
  }

  return parseRealtimeSheet(sheetId, actor, sheetSnapshot.val() as RealtimeSheetData);
}

export async function getDefaultRealtimeSheetId(): Promise<string | null> {
  const sheetsSnapshot = await firebaseAdminRealtimeDb.ref("sheets").get();

  if (!sheetsSnapshot.exists()) {
    return null;
  }

  const sheets = asRecord(sheetsSnapshot.val());
  let bestSheet: { key: string; nonEmptyCellCount: number; updatedAt: number } | null = null;

  for (const [key, value] of Object.entries(sheets)) {
    const sheet = asRecord(value);
    const metadata = asRecord(sheet.metadata);
    const updatedAt = Date.parse(
      asString(metadata.updatedAt) || asString(metadata.mirroredAt)
    );
    let nonEmptyCellCount = 0;

    for (const row of Object.values(asRecord(sheet.cells))) {
      const columns = asRecord(row);

      for (const columnKey of COLUMN_KEYS) {
        const cell = asRecord(columns[columnKey]);

        if (
          asString(cell.value) ||
          asNullableString(cell.formula) ||
          asString(cell.computedValue)
        ) {
          nonEmptyCellCount += 1;
        }
      }
    }

    const candidate = {
      key,
      nonEmptyCellCount,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };

    if (
      !bestSheet ||
      candidate.nonEmptyCellCount > bestSheet.nonEmptyCellCount ||
      (candidate.nonEmptyCellCount === bestSheet.nonEmptyCellCount &&
        candidate.updatedAt > bestSheet.updatedAt)
    ) {
      bestSheet = candidate;
    }
  }

  return bestSheet?.key ?? null;
}

export async function getRealtimeSheetSnapshot(
  sheetId: string,
  currentUser: Actor
): Promise<SheetSnapshot> {
  return (await readRealtimeSheet(sheetId, currentUser)).snapshot;
}

function applyCellUpdates(
  parsed: ParsedRealtimeSheet,
  actor: Actor,
  updates: Array<{ rowIndex: number; columnKey: ColumnKey; value: string }>
): AppliedRealtimeCellUpdates {
  const { snapshot, cells, ownerships, formats, rowMeta } = parsed;

  if (updates.length === 0) {
    return { snapshot, cells, cellHistoryLogs: [] };
  }

  const ownershipLookup = new Map(ownerships.map((ownership) => [ownership.rowIndex, ownership]));
  const previousCellLookup = new Map(
    cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell])
  );
  const editedCells: CellState[] = [];
  const now = nowIso();

  for (const update of updates) {
    if (!isValidRowIndex(update.rowIndex)) {
      throw new SheetRuleError("Rows must be between 1 and 1000.");
    }

    const previousCell = previousCellLookup.get(getCellKey(update.rowIndex, update.columnKey));
    const delaySourceCell = getDelaySourceCellForDecision(
      snapshot.columnPermissions,
      update.rowIndex,
      update.columnKey,
      previousCellLookup
    );
    const decision = getCellEditDecision({
      role: actor.role,
      userId: actor.id,
      columnKey: update.columnKey,
      columnPermissions: snapshot.columnPermissions,
      ownership: ownershipLookup.get(update.rowIndex) ?? null,
      currentValue: getCellRawValue(previousCell),
      delaySourceCell,
      memberEditLockAt: snapshot.viewSetting.memberEditLockAt
    });

    if (!decision.allowed) {
      throw new SheetRuleError(
        `${update.columnKey}${update.rowIndex}: ${
          decision.reason ?? "You cannot edit this cell."
        }`
      );
    }

    const validation = validateAllowedValue({
      role: actor.role,
      columnKey: update.columnKey,
      nextValue: update.value,
      validationRules: snapshot.validationRules
    });

    if (!validation.valid) {
      throw new SheetRuleError(
        `${update.columnKey}${update.rowIndex}: ${validation.reason ?? "The value is not allowed."}`
      );
    }

    const normalized = normalizeCellInput(update.value);
    editedCells.push({
      rowIndex: update.rowIndex,
      columnKey: update.columnKey,
      value: normalized.value,
      formula: normalized.formula,
      computedValue: normalized.value,
      updatedAt: now
    });
  }

  const nextCellsWithoutComputed = upsertEditedCells(cells, editedCells);
  const nextCells = mergeRecalculatedCells(
    nextCellsWithoutComputed,
    recalculateCells(nextCellsWithoutComputed)
  );
  const violations = evaluateConditionalRules({
    cells: nextCells,
    rules: snapshot.conditionalRules
  });

  if (violations.length > 0) {
    throw new SheetRuleError(violations[0].message);
  }

  const touchedRows = [...new Set(updates.map((update) => update.rowIndex))];
  const rowsToClaim =
    actor.role === Role.MEMBER
      ? touchedRows.filter((rowIndex) =>
          editedCells.some((cell) => {
            if (cell.rowIndex !== rowIndex || ownershipLookup.has(rowIndex)) {
              return false;
            }

            const previousCell = previousCellLookup.get(getCellKey(cell.rowIndex, cell.columnKey));
            const delaySourceCell = getDelaySourceCellForDecision(
              snapshot.columnPermissions,
              cell.rowIndex,
              cell.columnKey,
              previousCellLookup
            );
            const decision = getCellEditDecision({
              role: actor.role,
              userId: actor.id,
              columnKey: cell.columnKey,
              columnPermissions: snapshot.columnPermissions,
              ownership: ownershipLookup.get(rowIndex) ?? null,
              currentValue: getCellRawValue(previousCell),
              delaySourceCell,
              memberEditLockAt: snapshot.viewSetting.memberEditLockAt
            });

            return decision.willClaimRow && hasClaimableValue(cell);
          })
        )
      : [];
  const nextOwnerships = [
    ...ownerships,
    ...rowsToClaim.map((rowIndex) => ({
      rowIndex,
      ownerId: actor.id,
      ownerName: actor.name,
      updatedAt: now
    }))
  ];

  for (const rowIndex of touchedRows) {
    rowMeta.set(rowIndex, {
      lastEditedBy: actor.name,
      updatedAt: now
    });
  }

  const editedCellKeys = new Set(
    editedCells.map((cell) => getCellKey(cell.rowIndex, cell.columnKey))
  );
  const computedLookup = new Map(
    nextCells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell.computedValue ?? ""])
  );
  const detailedCellAuditInputs = editedCells.map((cell) => {
    const previousCell = previousCellLookup.get(getCellKey(cell.rowIndex, cell.columnKey));
    return {
      action: AuditAction.CELL_UPDATED,
      actorName: actor.name,
      rowIndex: cell.rowIndex,
      columnKey: cell.columnKey,
      message: `${actor.name} updated ${cell.columnKey}${cell.rowIndex}.`,
      metadata: {
        previousValue: getCellRawValue(previousCell),
        value: cell.formula ?? cell.value,
        previousComputedValue: previousCell?.computedValue ?? previousCell?.value ?? "",
        computedValue: computedLookup.get(getCellKey(cell.rowIndex, cell.columnKey)) ?? "",
        previousFormula: previousCell?.formula ?? null,
        formula: cell.formula ?? null,
        bulk: editedCells.length > 1
      }
    };
  });
  const cellHistoryLogs = createAuditLogs(detailedCellAuditInputs);
  const globalCellAuditLogs =
    editedCells.length <= DETAILED_BULK_AUDIT_LIMIT
      ? cellHistoryLogs
      : createAuditLogs([
          {
            action: AuditAction.CELL_UPDATED,
            actorName: actor.name,
            rowIndex: null,
            columnKey: null,
            message: `${actor.name} pasted ${editedCells.length} cells.`,
            metadata: {
              cellCount: editedCells.length,
              cells: [...editedCellKeys].slice(0, 500),
              truncated: editedCells.length > 500
            }
          }
        ]);
  const rowClaimLogs = rowsToClaim.map((rowIndex) => ({
    action: AuditAction.ROW_CLAIMED,
    actorName: actor.name,
    rowIndex,
    columnKey: null,
    message: `${actor.name} claimed row ${rowIndex}.`,
    metadata: null
  }));
  const globalAuditLogs = [
    ...createAuditLogs(rowClaimLogs),
    ...globalCellAuditLogs,
    ...snapshot.auditLogs
  ].slice(0, 30);

  return {
    snapshot: buildSnapshotFromParts({
      snapshot,
      cells: nextCells,
      ownerships: nextOwnerships,
      formats,
      rowMeta,
      auditLogs: globalAuditLogs
    }),
    cells: nextCells,
    cellHistoryLogs
  };
}

export async function claimRealtimeRowForEdit(
  actor: Actor,
  input: ClaimRowForEditInput
): Promise<SheetSnapshot> {
  assertColumnKey(input.columnKey);

  if (!isValidRowIndex(input.rowIndex)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  if (actor.role === Role.ADMIN) {
    return getRealtimeSheetSnapshot(input.sheetId, actor);
  }

  throw new SheetRuleError("Rows are claimed after a valid edit is saved.");
}

export async function updateRealtimeCell(
  actor: Actor,
  input: UpdateCellInput
): Promise<SheetSnapshot> {
  const columnKey = assertColumnKey(input.columnKey);
  const updates = [
    {
      rowIndex: input.rowIndex,
      columnKey,
      value: input.value
    }
  ];
  const result = applyCellUpdates(await readRealtimeSheet(input.sheetId, actor), actor, updates);
  const rows = getRowsForPersistedCellUpdates(result.snapshot, updates);

  await writeRealtimeRows(result.snapshot, rows, {
    includeCells: false,
    cellStates: selectCellsForPersistedUpdates(result.cells, rows, updates),
    cellHistoryLogs: result.cellHistoryLogs
  });
  return result.snapshot;
}

export async function bulkUpdateRealtimeCells(
  actor: Actor,
  input: BulkUpdateCellInput
): Promise<SheetSnapshot> {
  const updates = input.updates.map((update) => ({
    rowIndex: update.rowIndex,
    columnKey: assertColumnKey(update.columnKey),
    value: update.value
  }));
  const result = applyCellUpdates(await readRealtimeSheet(input.sheetId, actor), actor, updates);
  const rows = getRowsForPersistedCellUpdates(result.snapshot, updates);

  await writeRealtimeRows(result.snapshot, rows, {
    includeCells: false,
    cellStates: selectCellsForPersistedUpdates(result.cells, rows, updates),
    cellHistoryLogs: result.cellHistoryLogs
  });
  return result.snapshot;
}

export async function updateRealtimeCellFormats(
  actor: Actor,
  input: UpdateCellFormatsInput
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can format cells.", 403);
  }

  const parsed = await readRealtimeSheet(input.sheetId, actor);
  const startRow = Math.min(input.startRow, input.endRow);
  const endRow = Math.max(input.startRow, input.endRow);
  const startColumnKey = assertColumnKey(input.startColumnKey);
  const endColumnKey = assertColumnKey(input.endColumnKey);
  const startColumnIndex = COLUMN_KEYS.indexOf(startColumnKey);
  const endColumnIndex = COLUMN_KEYS.indexOf(endColumnKey);
  const targetColumns = COLUMN_KEYS.slice(
    Math.min(startColumnIndex, endColumnIndex),
    Math.max(startColumnIndex, endColumnIndex) + 1
  );

  if (!isValidRowIndex(startRow) || !isValidRowIndex(endRow)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  const formatLookup = new Map(
    parsed.formats.map((format) => [getCellKey(format.rowIndex, format.columnKey), format])
  );
  const patch = normalizeFormatPatch(input.format ?? {});
  const nextFormats: CellFormatEntryState[] = [];

  for (let rowIndex = 1; rowIndex <= MAX_ROWS; rowIndex += 1) {
    for (const columnKey of COLUMN_KEYS) {
      const current = formatLookup.get(getCellKey(rowIndex, columnKey));
      const isTarget =
        rowIndex >= startRow && rowIndex <= endRow && targetColumns.includes(columnKey);
      const nextFormat = isTarget
        ? input.clear
          ? createDefaultCellFormat()
          : mergeCellFormat(current ?? createDefaultCellFormat(), patch)
        : current;

      if (nextFormat && !isDefaultCellFormat(nextFormat)) {
        nextFormats.push({
          rowIndex,
          columnKey,
          ...nextFormat
        });
      }
    }
  }

  const rangeLabel = `${targetColumns[0]}${startRow}:${
    targetColumns[targetColumns.length - 1]
  }${endRow}`;
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    formats: nextFormats,
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.CELL_FORMAT_UPDATED,
        actorName: actor.name,
        rowIndex: startRow === endRow ? startRow : null,
        columnKey: targetColumns.length === 1 ? targetColumns[0] : null,
        message: input.clear
          ? `${actor.name} cleared formatting in ${rangeLabel}.`
          : `${actor.name} formatted ${rangeLabel}.`,
        metadata: {
          clear: Boolean(input.clear),
          range: rangeLabel
        }
      }
    ])
  });

  await writeRealtimeRows(
    nextSnapshot,
    nextSnapshot.rows.filter((row) => row.rowNumber >= startRow && row.rowNumber <= endRow)
  );
  return nextSnapshot;
}

export async function updateRealtimeColumnRuleSettings(
  actor: Actor,
  input: UpdateColumnRuleSettingsInput
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can update column rules.", 403);
  }

  const parsed = await readRealtimeSheet(input.sheetId, actor);
  const columnKey = assertColumnKey(input.columnKey);
  const memberEditDelayMinutes = normalizeDelayMinutes(input.memberEditDelayMinutes);
  const memberEditDelaySourceColumnKey =
    input.memberEditDelaySourceColumnKey &&
    memberEditDelayMinutes > 0 &&
    input.memberEditDelaySourceColumnKey !== columnKey
      ? assertColumnKey(input.memberEditDelaySourceColumnKey)
      : null;
  const nextPermission: ColumnPermissionState = {
    columnKey,
    editableByMember: input.editableByMember,
    claimRowOnEdit: input.editableByMember && input.claimRowOnEdit,
    memberWriteOnce: input.memberWriteOnce,
    memberEditDelaySourceColumnKey,
    memberEditDelayMinutes:
      input.editableByMember && memberEditDelaySourceColumnKey ? memberEditDelayMinutes : 0,
    duplicateHighlight: input.duplicateHighlight,
    matchHighlightTerms: normalizeMatchHighlightTerms(input.matchHighlightTerms)
  };
  const nextPermissions = parsed.snapshot.columnPermissions.map((permission) =>
    permission.columnKey === columnKey ? nextPermission : permission
  );
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    columnPermissions: nextPermissions,
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.COLUMN_PERMISSION_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey,
        message: `${actor.name} updated rules for column ${columnKey}.`,
        metadata: nextPermission
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function replaceRealtimeColumnPermissions(
  actor: Actor,
  sheetId: string,
  permissions: ColumnPermissionState[]
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can update column rules.", 403);
  }

  const parsed = await readRealtimeSheet(sheetId, actor);
  const permissionLookup = new Map(permissions.map((permission) => [permission.columnKey, permission]));
  const nextPermissions = COLUMN_KEYS.map((columnKey) =>
    normalizePermission(columnKey, permissionLookup.get(columnKey))
  );
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    columnPermissions: nextPermissions,
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.COLUMN_PERMISSION_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} updated column permissions.`,
        metadata: null
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function updateRealtimeSheetViewSettings(
  actor: Actor,
  input: UpdateSheetViewSettingsInput
): Promise<SheetViewSettingState> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can save sheet view settings.", 403);
  }

  const parsed = await readRealtimeSheet(input.sheetId, actor);
  const nextViewSetting: SheetViewSettingState = {
    ...parsed.snapshot.viewSetting,
    ...(input.alternateRowColors === undefined
      ? {}
      : { alternateRowColors: input.alternateRowColors }),
    ...(input.alternateOddColor === undefined
      ? {}
      : {
          alternateOddColor:
            normalizeHexColor(input.alternateOddColor) ??
            parsed.snapshot.viewSetting.alternateOddColor
        }),
    ...(input.alternateEvenColor === undefined
      ? {}
      : {
          alternateEvenColor:
            normalizeHexColor(input.alternateEvenColor) ??
            parsed.snapshot.viewSetting.alternateEvenColor
        }),
    ...(input.fontSize === undefined ? {} : { fontSize: normalizeSheetFontSize(input.fontSize) }),
    ...(input.columnWidths === undefined
      ? {}
      : { columnWidths: normalizeSheetColumnWidths(input.columnWidths) }),
    ...(input.condensedView === undefined
      ? {}
      : { condensedView: normalizeSheetCondensedView(input.condensedView) }),
    ...(input.frozenHeaderRowIndex === undefined
      ? {}
      : {
          frozenHeaderRowIndex: normalizeSheetFrozenHeaderRowIndex(input.frozenHeaderRowIndex)
        }),
    ...(input.frozenHeaderColumnKey === undefined
      ? {}
      : {
          frozenHeaderColumnKey: normalizeSheetFrozenHeaderColumnKey(input.frozenHeaderColumnKey)
        }),
    ...(input.memberEditLockAt === undefined
      ? {}
      : {
          memberEditLockAt: input.memberEditLockAt
            ? new Date(input.memberEditLockAt).toISOString()
            : null
        })
  };
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    viewSetting: nextViewSetting,
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.SHEET_VIEW_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} updated sheet view settings.`,
        metadata: {
          memberEditLockAt: nextViewSetting.memberEditLockAt
        }
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextViewSetting;
}

export async function unlockAllRealtimeRows(actor: Actor, sheetId: string): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can unlock rows.", 403);
  }

  const parsed = await readRealtimeSheet(sheetId, actor);
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    ownerships: [],
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.ROW_UNLOCKED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} unlocked all rows.`,
        metadata: {
          unlockedRows: parsed.ownerships.length
        }
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function unlockRealtimeRows(
  actor: Actor,
  sheetId: string,
  rowIndexes: number[]
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can unlock rows.", 403);
  }

  const targetRowIndexes = normalizeRowIndexes(rowIndexes);
  const targetLookup = new Set(targetRowIndexes);
  const parsed = await readRealtimeSheet(sheetId, actor);
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    ownerships: parsed.ownerships.filter((ownership) => !targetLookup.has(ownership.rowIndex)),
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.ROW_UNLOCKED,
        actorName: actor.name,
        rowIndex: targetRowIndexes.length === 1 ? targetRowIndexes[0] : null,
        columnKey: null,
        message:
          targetRowIndexes.length === 1
            ? `${actor.name} unlocked row ${targetRowIndexes[0]}.`
            : `${actor.name} unlocked ${targetRowIndexes.length} rows.`,
        metadata: {
          rowIndexes: targetRowIndexes
        }
      }
    ])
  });

  await writeRealtimeRows(nextSnapshot, selectRowsByIndexes(nextSnapshot, targetRowIndexes));
  return nextSnapshot;
}

export async function resetRealtimeRows(
  actor: Actor,
  sheetId: string,
  rowIndexes: number[]
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can reset rows.", 403);
  }

  const targetRowIndexes = normalizeRowIndexes(rowIndexes);
  const parsed = await readRealtimeSheet(sheetId, actor);
  const resetColumns = parsed.snapshot.columnPermissions
    .filter((permission) => permission.editableByMember)
    .map((permission) => permission.columnKey);
  const now = nowIso();
  const resetCells: CellState[] = targetRowIndexes.flatMap((rowIndex) =>
    resetColumns.map((columnKey) => ({
      rowIndex,
      columnKey,
      value: "",
      formula: null,
      computedValue: "",
      updatedAt: now
    }))
  );
  const previousCellLookup = new Map(
    parsed.cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell])
  );
  const resetCellHistoryLogs = createAuditLogs(
    resetCells.map((cell) => {
      const previousCell = previousCellLookup.get(getCellKey(cell.rowIndex, cell.columnKey));

      return {
        action: AuditAction.CELL_UPDATED,
        actorName: actor.name,
        rowIndex: cell.rowIndex,
        columnKey: cell.columnKey,
        message: `${actor.name} reset ${cell.columnKey}${cell.rowIndex}.`,
        metadata: {
          previousValue: getCellRawValue(previousCell),
          value: "",
          previousComputedValue: previousCell?.computedValue ?? previousCell?.value ?? "",
          computedValue: "",
          previousFormula: previousCell?.formula ?? null,
          formula: null,
          reset: true
        }
      };
    })
  );
  const nextCellsWithoutComputed = upsertEditedCells(parsed.cells, resetCells);
  const nextCells = mergeRecalculatedCells(
    nextCellsWithoutComputed,
    recalculateCells(nextCellsWithoutComputed)
  );
  const targetLookup = new Set(targetRowIndexes);

  for (const rowIndex of targetRowIndexes) {
    parsed.rowMeta.set(rowIndex, {
      lastEditedBy: actor.name,
      updatedAt: now
    });
  }

  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    cells: nextCells,
    ownerships: parsed.ownerships.filter((ownership) => !targetLookup.has(ownership.rowIndex)),
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.CELL_UPDATED,
        actorName: actor.name,
        rowIndex: targetRowIndexes.length === 1 ? targetRowIndexes[0] : null,
        columnKey: null,
        message:
          targetRowIndexes.length === 1
            ? `${actor.name} reset row ${targetRowIndexes[0]}.`
            : `${actor.name} reset ${targetRowIndexes.length} rows.`,
        metadata: {
          rowIndexes: targetRowIndexes,
          resetColumns,
          clearedCells: resetColumns.length * targetRowIndexes.length
        }
      }
    ])
  });

  await writeRealtimeRows(
    nextSnapshot,
    selectRowsByIndexes(
      nextSnapshot,
      new Set([
        ...targetRowIndexes,
        ...getRowsForPersistedCellUpdates(
          nextSnapshot,
          resetCells.map((cell) => ({
            rowIndex: cell.rowIndex,
            columnKey: cell.columnKey
          }))
        ).map((row) => row.rowNumber)
      ])
    ),
    {
      cellHistoryLogs: resetCellHistoryLogs
    }
  );
  return nextSnapshot;
}

export async function getRealtimeCellHistory(
  actor: Actor,
  input: GetCellHistoryInput
): Promise<CellHistoryEntryState[]> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can view cell history.", 403);
  }

  const columnKey = assertColumnKey(input.columnKey);

  if (!isValidRowIndex(input.rowIndex)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  let cellHistoryLogs: AuditLogState[] = [];

  try {
    const historySnapshot = await firebaseAdminRealtimeDb
      .ref(`sheets/${safeKey(input.sheetId)}/cellHistory/${safeKey(input.rowIndex)}/${columnKey}`)
      .get();

    cellHistoryLogs = historySnapshot.exists()
      ? parseAuditLogs(historySnapshot.val(), CELL_HISTORY_LIMIT)
      : [];
  } catch (error) {
    console.warn("Unable to read realtime cell history path.", error);
  }

  if (cellHistoryLogs.length > 0) {
    return cellHistoryLogs.map((log) => ({
      id: log.id,
      action: log.action,
      actorName: log.actorName,
      message: log.message,
      previousValue: getMetadataString(log.metadata, "previousValue"),
      value: getMetadataString(log.metadata, "value"),
      previousComputedValue: getMetadataString(log.metadata, "previousComputedValue"),
      computedValue: getMetadataString(log.metadata, "computedValue"),
      previousFormula: getMetadataString(log.metadata, "previousFormula"),
      formula: getMetadataString(log.metadata, "formula"),
      createdAt: log.createdAt
    }));
  }

  const snapshot = await getRealtimeSheetSnapshot(input.sheetId, actor);

  return snapshot.auditLogs
    .filter(
      (log) =>
        log.rowIndex === input.rowIndex &&
        log.columnKey === columnKey &&
        (log.action === AuditAction.CELL_UPDATED ||
          log.action === AuditAction.CELL_FORMAT_UPDATED)
    )
    .map((log) => ({
      id: log.id,
      action: log.action,
      actorName: log.actorName,
      message: log.message,
      previousValue: getMetadataString(log.metadata, "previousValue"),
      value: getMetadataString(log.metadata, "value"),
      previousComputedValue: getMetadataString(log.metadata, "previousComputedValue"),
      computedValue: getMetadataString(log.metadata, "computedValue"),
      previousFormula: getMetadataString(log.metadata, "previousFormula"),
      formula: getMetadataString(log.metadata, "formula"),
      createdAt: log.createdAt
    }));
}

export async function saveRealtimeValidationRule(
  actor: Actor,
  input: {
    sheetId: string;
    id?: string;
    columnKey: ColumnKey;
    name: string;
    allowedValues: string[];
    enabled: boolean;
  }
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can save validation rules.", 403);
  }

  const parsed = await readRealtimeSheet(input.sheetId, actor);
  const id = input.id || createId("validation");
  const rule: ValidationRuleState = {
    id,
    columnKey: input.columnKey,
    name: input.name,
    allowedValues: input.allowedValues,
    enabled: input.enabled
  };
  const existingRules = parsed.snapshot.validationRules.filter((item) => item.id !== id);
  const existingSingleValueLimits = new Set<string>();

  for (const conditionalRule of parsed.snapshot.conditionalRules) {
    for (const condition of conditionalRule.conditions) {
      if (condition.columnKey !== input.columnKey || condition.values.length !== 1) {
        continue;
      }

      existingSingleValueLimits.add(condition.values[0].toLowerCase());
    }
  }

  const missingValues = input.allowedValues.filter(
    (value) => !existingSingleValueLimits.has(value.toLowerCase())
  );
  const newConditionalRules: ConditionalRuleState[] = missingValues.map((value) => ({
    id: createId("conditional"),
    name: `${input.columnKey}: ${value}`,
    description: `Default one-match limit for ${value}.`,
    limitCount: 1,
    enabled: input.enabled,
    conditions: [
      {
        id: createId("condition"),
        columnKey: input.columnKey,
        operator: RuleOperator.EQUALS,
        joinOperator: RuleJoinOperator.AND,
        values: [value]
      }
    ]
  }));
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    validationRules: [...existingRules, rule],
    conditionalRules: [...parsed.snapshot.conditionalRules, ...newConditionalRules],
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.VALIDATION_RULE_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: input.columnKey,
        message: `${actor.name} saved validation rule "${input.name}".`,
        metadata: {
          missingValues
        }
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function deleteRealtimeValidationRule(
  actor: Actor,
  sheetId: string,
  id: string
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can delete validation rules.", 403);
  }

  const parsed = await readRealtimeSheet(sheetId, actor);
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    validationRules: parsed.snapshot.validationRules.filter((rule) => rule.id !== id),
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.VALIDATION_RULE_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} deleted a validation rule.`,
        metadata: null
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function saveRealtimeConditionalRule(
  actor: Actor,
  input: {
    sheetId: string;
    id?: string;
    name: string;
    description: string | null;
    limitCount: number;
    enabled: boolean;
    conditions: ConditionalRuleState["conditions"];
  }
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can save conditional rules.", 403);
  }

  const parsed = await readRealtimeSheet(input.sheetId, actor);
  const id = input.id || createId("conditional");
  const rule: ConditionalRuleState = {
    id,
    name: input.name,
    description: input.description,
    limitCount: Math.max(1, input.limitCount),
    enabled: input.enabled,
    conditions: input.conditions.map((condition, index) => ({
      ...condition,
      id: condition.id ?? createId("condition"),
      joinOperator: index === 0 ? RuleJoinOperator.AND : condition.joinOperator
    }))
  };
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    conditionalRules: [
      ...parsed.snapshot.conditionalRules.filter((item) => item.id !== id),
      rule
    ],
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.CONDITIONAL_RULE_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} saved conditional rule "${input.name}".`,
        metadata: null
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function deleteRealtimeConditionalRule(
  actor: Actor,
  sheetId: string,
  id: string
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can delete conditional rules.", 403);
  }

  const parsed = await readRealtimeSheet(sheetId, actor);
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    conditionalRules: parsed.snapshot.conditionalRules.filter((rule) => rule.id !== id),
    auditLogs: appendAuditLogs(parsed.snapshot, [
      {
        action: AuditAction.CONDITIONAL_RULE_UPDATED,
        actorName: actor.name,
        rowIndex: null,
        columnKey: null,
        message: `${actor.name} deleted a conditional rule.`,
        metadata: null
      }
    ])
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export async function deleteRealtimeAuditHistory(
  actor: Actor,
  sheetId: string,
  options: { olderThanIso?: string } = {}
): Promise<SheetSnapshot> {
  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can delete audit history.", 403);
  }

  const parsed = await readRealtimeSheet(sheetId, actor);
  const cutoff = options.olderThanIso ? new Date(options.olderThanIso).getTime() : null;
  const keptLogs = cutoff
    ? parsed.snapshot.auditLogs.filter((log) => new Date(log.createdAt).getTime() >= cutoff)
    : [];
  const deletedCount = parsed.snapshot.auditLogs.length - keptLogs.length;
  const nextSnapshot = buildSnapshotFromParts({
    ...parsed,
    auditLogs: appendAuditLogs(
      {
        ...parsed.snapshot,
        auditLogs: keptLogs
      },
      [
        {
          action: AuditAction.AUDIT_HISTORY_CLEANED,
          actorName: actor.name,
          rowIndex: null,
          columnKey: null,
          message: `${actor.name} deleted ${deletedCount} audit entr${
            deletedCount === 1 ? "y" : "ies"
          }.`,
          metadata: {
            deletedCount
          }
        }
      ]
    )
  });

  await writeRealtimeSnapshot(nextSnapshot);
  return nextSnapshot;
}

export function getRealtimeRowsForSnapshot(snapshot: SheetSnapshot, rowIndexes: number[]): SheetSnapshot["rows"] {
  const wanted = new Set(rowIndexes);
  return snapshot.rows.filter((row) => wanted.has(row.rowNumber));
}
