import type { ColumnKey } from "@/lib/constants";
import type {
  AuditLogState,
  CellFormatState,
  SheetGridRow,
  SheetSnapshot
} from "@/lib/sheet/types";
import { firebaseAdminRealtimeDb } from "./admin";

const RTDB_SCHEMA_VERSION = 1;
const FORBIDDEN_RTDB_KEY_CHARS = /[.#$/[\]]/g;

function isRealtimeMirrorEnabled(force = false): boolean {
  return force || process.env.ENABLE_RTDB_MIRROR === "true";
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

function isDefaultFormat(format: CellFormatState): boolean {
  return (
    !format.bold &&
    !format.italic &&
    !format.underline &&
    !format.textColor &&
    !format.backgroundColor &&
    !format.horizontalAlign
  );
}

function serializeRowCells(
  row: SheetGridRow,
  columns: ColumnKey[]
): Record<ColumnKey, {
  value: string;
  formula: string | null;
  computedValue: string;
  updatedAt: string | null;
}> {
  return Object.fromEntries(
    columns.map((columnKey) => {
      const rawValue = String(row[columnKey] ?? "");
      return [
        columnKey,
        {
          value: row.__formula[columnKey] ? "" : rawValue,
          formula: row.__formula[columnKey] ? rawValue : null,
          computedValue: row.__computed[columnKey] ?? rawValue,
          updatedAt: row.__cellUpdatedAt?.[columnKey] ?? null
        }
      ];
    })
  ) as Record<ColumnKey, {
    value: string;
    formula: string | null;
    computedValue: string;
    updatedAt: string | null;
  }>;
}

function serializeRowFormats(
  row: SheetGridRow,
  columns: ColumnKey[]
): Partial<Record<ColumnKey, CellFormatState>> | null {
  const formats = Object.fromEntries(
    columns.flatMap((columnKey) => {
      const format = row.__format[columnKey];

      return isDefaultFormat(format) ? [] : [[columnKey, serializeCellFormat(format)]];
    })
  ) as Partial<Record<ColumnKey, CellFormatState>>;

  return Object.keys(formats).length > 0 ? formats : null;
}

function serializeRowMeta(row: SheetGridRow): {
  lastEditedBy: string | null;
  updatedAt: string | null;
  duplicateHighlight: boolean;
  matchHighlight: boolean;
} {
  return {
    lastEditedBy: row.lastEditedBy,
    updatedAt: row.updatedAt,
    duplicateHighlight: row.__duplicateHighlight,
    matchHighlight: row.__matchHighlight
  };
}

function serializeRowOwnership(row: SheetGridRow): {
  ownerId: string;
  ownerName: string | null;
  updatedAt: string | null;
} | null {
  return row.ownerId
    ? {
        ownerId: row.ownerId,
        ownerName: row.ownerName,
        updatedAt: row.updatedAt
      }
    : null;
}

function serializeAuditLogs(
  auditLogs: AuditLogState[]
): Record<string, Omit<AuditLogState, "id">> | null {
  const entries = Object.fromEntries(
    auditLogs.map((log) => [
      safeKey(log.id),
      {
        action: log.action,
        actorName: log.actorName,
        rowIndex: log.rowIndex,
        columnKey: log.columnKey,
        message: log.message,
        metadata: log.metadata ?? null,
        createdAt: log.createdAt
      }
    ])
  );

  return Object.keys(entries).length > 0 ? entries : null;
}

function serializeSheetConfig(snapshot: SheetSnapshot) {
  return {
    schemaVersion: RTDB_SCHEMA_VERSION,
    metadata: {
      id: snapshot.sheet.id,
      name: snapshot.sheet.name,
      sourceOfTruth: "sql",
      mirroredAt: nowIso()
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
    )
  };
}

function serializeFullSheet(snapshot: SheetSnapshot) {
  return cleanForRealtimeDatabase({
    ...serializeSheetConfig(snapshot),
    cells: Object.fromEntries(
      snapshot.rows.map((row) => [
        safeKey(row.rowNumber),
        serializeRowCells(row, snapshot.columns)
      ])
    ),
    rowMeta: Object.fromEntries(
      snapshot.rows.map((row) => [safeKey(row.rowNumber), serializeRowMeta(row)])
    ),
    ownership: Object.fromEntries(
      snapshot.rows.flatMap((row) => {
        const ownership = serializeRowOwnership(row);
        return ownership ? [[safeKey(row.rowNumber), ownership]] : [];
      })
    ),
    formats: Object.fromEntries(
      snapshot.rows.flatMap((row) => {
        const formats = serializeRowFormats(row, snapshot.columns);
        return formats ? [[safeKey(row.rowNumber), formats]] : [];
      })
    ),
    audit: serializeAuditLogs(snapshot.auditLogs)
  });
}

async function mirrorSafely(
  label: string,
  task: () => Promise<void>
): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.warn(`Unable to mirror ${label} to Realtime Database.`, error);
  }
}

export async function mirrorSheetSnapshotToRealtimeDatabase(
  snapshot: SheetSnapshot,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isRealtimeMirrorEnabled(options.force)) {
    return;
  }

  await mirrorSafely("sheet snapshot", async () => {
    await firebaseAdminRealtimeDb
      .ref(`sheets/${safeKey(snapshot.sheet.id)}`)
      .set(serializeFullSheet(snapshot));
  });
}

export async function mirrorSheetConfigToRealtimeDatabase(
  snapshot: SheetSnapshot,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isRealtimeMirrorEnabled(options.force)) {
    return;
  }

  const sheetPath = `sheets/${safeKey(snapshot.sheet.id)}`;

  await mirrorSafely("sheet config", async () => {
    await firebaseAdminRealtimeDb.ref().update(
      cleanForRealtimeDatabase({
        [`${sheetPath}/schemaVersion`]: RTDB_SCHEMA_VERSION,
        [`${sheetPath}/metadata`]: {
          id: snapshot.sheet.id,
          name: snapshot.sheet.name,
          sourceOfTruth: "sql",
          mirroredAt: nowIso()
        },
        [`${sheetPath}/columns`]: snapshot.columns,
        [`${sheetPath}/permissions`]: Object.fromEntries(
          snapshot.columnPermissions.map((permission) => [permission.columnKey, permission])
        ),
        [`${sheetPath}/viewSetting`]: snapshot.viewSetting,
        [`${sheetPath}/validationRules`]: Object.fromEntries(
          snapshot.validationRules.map((rule, index) => [
            safeKey(rule.id ?? `${rule.columnKey}-${index}`),
            rule
          ])
        ),
        [`${sheetPath}/conditionalRules`]: Object.fromEntries(
          snapshot.conditionalRules.map((rule) => [safeKey(rule.id), rule])
        ),
        [`${sheetPath}/audit`]: serializeAuditLogs(snapshot.auditLogs)
      })
    );
  });
}

export async function mirrorSheetRowsToRealtimeDatabase(
  snapshot: SheetSnapshot,
  rows: SheetGridRow[],
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isRealtimeMirrorEnabled(options.force) || rows.length === 0) {
    return;
  }

  const sheetPath = `sheets/${safeKey(snapshot.sheet.id)}`;
  const updates: Record<string, unknown> = {
    [`${sheetPath}/metadata/mirroredAt`]: nowIso(),
    [`${sheetPath}/metadata/sourceOfTruth`]: "sql",
    [`${sheetPath}/audit`]: serializeAuditLogs(snapshot.auditLogs)
  };

  for (const row of rows) {
    const rowKey = safeKey(row.rowNumber);
    updates[`${sheetPath}/cells/${rowKey}`] = serializeRowCells(row, snapshot.columns);
    updates[`${sheetPath}/rowMeta/${rowKey}`] = serializeRowMeta(row);
    updates[`${sheetPath}/ownership/${rowKey}`] = serializeRowOwnership(row);
    updates[`${sheetPath}/formats/${rowKey}`] = serializeRowFormats(row, snapshot.columns);
  }

  await mirrorSafely("sheet rows", async () => {
    await firebaseAdminRealtimeDb.ref().update(cleanForRealtimeDatabase(updates));
  });
}

export async function mirrorUserProfileToRealtimeDatabase(
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  },
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isRealtimeMirrorEnabled(options.force)) {
    return;
  }

  await mirrorSafely("user profile", async () => {
    await firebaseAdminRealtimeDb.ref(`users/${safeKey(user.id)}`).set(
      cleanForRealtimeDatabase({
        email: user.email,
        name: user.name,
        role: user.role,
        mirroredAt: nowIso()
      })
    );
  });
}

export async function deleteUserProfileFromRealtimeDatabase(
  userId: string,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isRealtimeMirrorEnabled(options.force)) {
    return;
  }

  await mirrorSafely("user profile deletion", async () => {
    await firebaseAdminRealtimeDb.ref(`users/${safeKey(userId)}`).remove();
  });
}
