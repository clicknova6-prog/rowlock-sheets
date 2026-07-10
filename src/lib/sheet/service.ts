import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { AuditAction, Role } from "@/generated/prisma/enums";
import { COLUMN_KEYS, assertColumnKey, getCellKey, isValidRowIndex } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import { isRealtimeDatabaseSource } from "@/lib/data-source";
import { prisma } from "@/lib/db";
import {
  createDefaultCellFormat,
  DEFAULT_SHEET_VIEW_SETTING,
  isDefaultCellFormat,
  mergeCellFormat,
  normalizeFormatPatch,
  normalizeHexColor,
  normalizeSheetColumnWidths,
  normalizeSheetCondensedView,
  normalizeSheetFrozenHeaderColumnKey,
  normalizeSheetFrozenHeaderRowIndex,
  normalizeSheetFontSize
} from "./formatting";
import { normalizeCellInput, recalculateCells, mergeRecalculatedCells } from "./formulas";
import { SheetRuleError } from "./errors";
import { getCellEditDecision } from "./permissions";
import { evaluateConditionalRules } from "./rules";
import { getSheetSnapshot, mapConditionalRule, mapValidationRule } from "./snapshot";
import { validateAllowedValue } from "./validation";
import type {
  Actor,
  CellFormatPatch,
  CellFormatState,
  CellHistoryEntryState,
  CellState,
  ColumnPermissionState,
  ConditionalRuleState,
  RowOwnershipState,
  SheetViewSettingState,
  SheetSnapshot
} from "./types";

const DETAILED_BULK_AUDIT_LIMIT = 100;
const BULK_SQL_WRITE_CHUNK_SIZE = 200;
const BULK_AUDIT_CELL_REFERENCE_LIMIT = 500;

export { SheetRuleError } from "./errors";

export interface UpdateCellInput {
  sheetId: string;
  rowIndex: number;
  columnKey: string;
  value: string;
}

export interface BulkUpdateCellInput {
  sheetId: string;
  updates: Array<{
    rowIndex: number;
    columnKey: string;
    value: string;
  }>;
}

export interface ClaimRowForEditInput {
  sheetId: string;
  rowIndex: number;
  columnKey: string;
}

export interface UpdateCellFormatsInput {
  sheetId: string;
  startRow: number;
  endRow: number;
  startColumnKey: string;
  endColumnKey: string;
  format?: CellFormatPatch;
  clear?: boolean;
}

export interface GetCellHistoryInput {
  sheetId: string;
  rowIndex: number;
  columnKey: string;
}

export interface UpdateColumnRuleSettingsInput {
  sheetId: string;
  columnKey: string;
  editableByMember: boolean;
  claimRowOnEdit: boolean;
  memberWriteOnce: boolean;
  memberEditDelaySourceColumnKey?: string | null;
  memberEditDelayMinutes?: number;
  duplicateHighlight: boolean;
  matchHighlightTerms?: string[];
}

export interface UpdateSheetViewSettingsInput {
  sheetId: string;
  alternateRowColors?: boolean;
  alternateOddColor?: string;
  alternateEvenColor?: string;
  fontSize?: number | string;
  columnWidths?: Record<string, number>;
  condensedView?: boolean;
  frozenHeaderRowIndex?: number | null;
  frozenHeaderColumnKey?: ColumnKey | string | null;
  memberEditLockAt?: Date | string | null;
}

function hasClaimableValue(cell: CellState): boolean {
  return (cell.formula ?? cell.value).trim().length > 0;
}

function normalizeMatchHighlightTerms(values: string[] | undefined): string[] {
  const terms = new Set<string>();

  for (const value of values ?? []) {
    const term = value.trim();

    if (term) {
      terms.add(term);
    }
  }

  return [...terms].slice(0, 500);
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

function normalizeExistingCells(
  cells: Array<{
    rowIndex: number;
    columnKey: string;
    value: string;
    formula: string | null;
    computedValue: string | null;
    updatedAt?: Date | string | null;
  }>
): CellState[] {
  return cells.map((cell) => ({
    rowIndex: cell.rowIndex,
    columnKey: assertColumnKey(cell.columnKey),
    value: cell.value,
    formula: cell.formula,
    computedValue: cell.computedValue,
    updatedAt: cell.updatedAt ?? null
  }));
}

function normalizeExistingCellFormat(format: {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textColor: string | null;
  backgroundColor: string | null;
  horizontalAlign: string | null;
}): CellFormatState {
  return {
    bold: format.bold,
    italic: format.italic,
    underline: format.underline,
    textColor: format.textColor,
    backgroundColor: format.backgroundColor,
    horizontalAlign:
      format.horizontalAlign === "left" ||
      format.horizontalAlign === "center" ||
      format.horizontalAlign === "right"
        ? format.horizontalAlign
        : null
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

function getMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : String(value);
}

function upsertEditedCell(cells: CellState[], editedCell: CellState): CellState[] {
  const lookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));
  lookup.set(getCellKey(editedCell.rowIndex, editedCell.columnKey), editedCell);
  return [...lookup.values()];
}

function upsertEditedCells(cells: CellState[], editedCells: CellState[]): CellState[] {
  const lookup = new Map(cells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell]));

  for (const cell of editedCells) {
    lookup.set(getCellKey(cell.rowIndex, cell.columnKey), cell);
  }

  return [...lookup.values()];
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function createDatabaseId(): string {
  return randomUUID().replaceAll("-", "");
}

function getBulkAuditMetadata(editedCells: CellState[]): Prisma.InputJsonValue {
  const cellReferences = editedCells
    .slice(0, BULK_AUDIT_CELL_REFERENCE_LIMIT)
    .map((cell) => `${cell.columnKey}${cell.rowIndex}`);

  return {
    cellCount: editedCells.length,
    cells: cellReferences,
    truncated: editedCells.length > BULK_AUDIT_CELL_REFERENCE_LIMIT
  };
}

async function upsertBulkSheetRows(
  sheetId: string,
  rowIndexes: number[],
  actorId: string
): Promise<void> {
  for (const rowChunk of chunkArray(rowIndexes, BULK_SQL_WRITE_CHUNK_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO \`SheetRow\` (
          \`id\`,
          \`sheetId\`,
          \`rowIndex\`,
          \`lastEditedById\`,
          \`createdAt\`,
          \`updatedAt\`
        )
        VALUES ${Prisma.join(
          rowChunk.map(
            (rowIndex) =>
              Prisma.sql`(${createDatabaseId()}, ${sheetId}, ${rowIndex}, ${actorId}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`
          )
        )}
        ON DUPLICATE KEY UPDATE
          \`lastEditedById\` = VALUES(\`lastEditedById\`),
          \`updatedAt\` = CURRENT_TIMESTAMP(3)
      `
    );
  }
}

async function claimBulkRows(
  sheetId: string,
  rowIndexes: number[],
  actorId: string
): Promise<void> {
  for (const rowChunk of chunkArray(rowIndexes, BULK_SQL_WRITE_CHUNK_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO \`RowOwnership\` (
          \`id\`,
          \`sheetId\`,
          \`rowIndex\`,
          \`ownerId\`,
          \`createdAt\`,
          \`updatedAt\`
        )
        VALUES ${Prisma.join(
          rowChunk.map(
            (rowIndex) =>
              Prisma.sql`(${createDatabaseId()}, ${sheetId}, ${rowIndex}, ${actorId}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`
          )
        )}
        ON DUPLICATE KEY UPDATE
          \`ownerId\` = \`ownerId\`
      `
    );
  }
}

async function upsertBulkCells(
  sheetId: string,
  editedCells: CellState[],
  computedLookup: Map<string, string>,
  actorId: string
): Promise<void> {
  for (const cellChunk of chunkArray(editedCells, BULK_SQL_WRITE_CHUNK_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO \`Cell\` (
          \`id\`,
          \`sheetId\`,
          \`rowIndex\`,
          \`columnKey\`,
          \`value\`,
          \`formula\`,
          \`computedValue\`,
          \`updatedById\`,
          \`createdAt\`,
          \`updatedAt\`
        )
        VALUES ${Prisma.join(
          cellChunk.map((cell) => {
            const computedValue = computedLookup.get(getCellKey(cell.rowIndex, cell.columnKey)) ?? "";

            return Prisma.sql`(${createDatabaseId()}, ${sheetId}, ${cell.rowIndex}, ${cell.columnKey}, ${cell.value}, ${cell.formula ?? null}, ${computedValue}, ${actorId}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`;
          })
        )}
        ON DUPLICATE KEY UPDATE
          \`value\` = VALUES(\`value\`),
          \`formula\` = VALUES(\`formula\`),
          \`computedValue\` = VALUES(\`computedValue\`),
          \`updatedById\` = VALUES(\`updatedById\`),
          \`updatedAt\` = CURRENT_TIMESTAMP(3)
      `
    );
  }
}

async function refreshBulkFormulaCells(
  sheetId: string,
  formulaCells: CellState[]
): Promise<void> {
  for (const cellChunk of chunkArray(formulaCells, BULK_SQL_WRITE_CHUNK_SIZE)) {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO \`Cell\` (
          \`id\`,
          \`sheetId\`,
          \`rowIndex\`,
          \`columnKey\`,
          \`value\`,
          \`formula\`,
          \`computedValue\`,
          \`createdAt\`,
          \`updatedAt\`
        )
        VALUES ${Prisma.join(
          cellChunk.map(
            (cell) =>
              Prisma.sql`(${createDatabaseId()}, ${sheetId}, ${cell.rowIndex}, ${cell.columnKey}, ${cell.value}, ${cell.formula ?? ""}, ${cell.computedValue ?? ""}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`
          )
        )}
        ON DUPLICATE KEY UPDATE
          \`computedValue\` = VALUES(\`computedValue\`),
          \`updatedAt\` = CURRENT_TIMESTAMP(3)
      `
    );
  }
}

async function getPermissionStates(sheetId: string): Promise<ColumnPermissionState[]> {
  const permissions = await prisma.columnPermission.findMany({
    where: { sheetId },
    select: {
      columnKey: true,
      editableByMember: true,
      claimRowOnEdit: true,
      memberWriteOnce: true,
      memberEditDelaySourceColumnKey: true,
      memberEditDelayMinutes: true,
      duplicateHighlight: true,
      matchHighlightTerms: true
    }
  });

  return permissions.map((permission) => ({
    columnKey: assertColumnKey(permission.columnKey),
    editableByMember: permission.editableByMember,
    claimRowOnEdit: permission.claimRowOnEdit,
    memberWriteOnce: permission.memberWriteOnce,
    memberEditDelaySourceColumnKey:
      permission.memberEditDelaySourceColumnKey &&
      COLUMN_KEYS.includes(permission.memberEditDelaySourceColumnKey as ColumnKey)
        ? (permission.memberEditDelaySourceColumnKey as ColumnKey)
        : null,
    memberEditDelayMinutes: normalizeDelayMinutes(permission.memberEditDelayMinutes),
    duplicateHighlight: permission.duplicateHighlight,
    matchHighlightTerms: Array.isArray(permission.matchHighlightTerms)
      ? permission.matchHighlightTerms.map((term) => String(term)).filter(Boolean)
      : []
  }));
}

async function getOwnershipState(
  sheetId: string,
  rowIndex: number
): Promise<RowOwnershipState | null> {
  const ownership = await prisma.rowOwnership.findUnique({
    where: { sheetId_rowIndex: { sheetId, rowIndex } },
    include: { owner: { select: { name: true } } }
  });

  if (!ownership) {
    return null;
  }

  return {
    rowIndex,
    ownerId: ownership.ownerId,
    ownerName: ownership.owner.name,
    updatedAt: ownership.updatedAt.toISOString()
  };
}

async function getConditionalRules(sheetId: string): Promise<ConditionalRuleState[]> {
  const rules = await prisma.conditionalRule.findMany({
    where: { sheetId },
    include: { conditions: { orderBy: { createdAt: "asc" } } }
  });

  return rules.map(mapConditionalRule);
}

export async function claimRowForEdit(
  actor: Actor,
  input: ClaimRowForEditInput
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { claimRealtimeRowForEdit } = await import("./rtdb-service");
    return claimRealtimeRowForEdit(actor, input);
  }

  const columnKey = assertColumnKey(input.columnKey);

  if (!isValidRowIndex(input.rowIndex)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  if (actor.role === Role.ADMIN) {
    return getSheetSnapshot(input.sheetId, actor);
  }

  void columnKey;
  throw new SheetRuleError("Rows are claimed after a valid edit is saved.");
}

export async function updateCell(
  actor: Actor,
  input: UpdateCellInput
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { updateRealtimeCell } = await import("./rtdb-service");
    return updateRealtimeCell(actor, input);
  }

  const columnKey = assertColumnKey(input.columnKey);

  if (!isValidRowIndex(input.rowIndex)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  const [columnPermissions, ownership, validationRules, conditionalRules, existingCells, viewSetting] =
    await Promise.all([
      getPermissionStates(input.sheetId),
      getOwnershipState(input.sheetId, input.rowIndex),
      prisma.validationRule.findMany({
        where: { sheetId: input.sheetId, columnKey, enabled: true }
      }),
      getConditionalRules(input.sheetId),
      prisma.cell.findMany({
        where: { sheetId: input.sheetId },
        select: {
          rowIndex: true,
          columnKey: true,
          value: true,
          formula: true,
          computedValue: true,
          updatedAt: true
        }
      }),
      prisma.sheetViewSetting.findUnique({
        where: { sheetId: input.sheetId },
        select: { memberEditLockAt: true }
      })
    ]);

  const validationDecision = validateAllowedValue({
    role: actor.role,
    columnKey,
    nextValue: input.value,
    validationRules: validationRules.map(mapValidationRule)
  });

  if (!validationDecision.valid) {
    throw new SheetRuleError(validationDecision.reason ?? "The value is not allowed.");
  }

  const normalizedInput = normalizeCellInput(input.value);
  const existingCellStates = normalizeExistingCells(existingCells);
  const previousCellLookup = new Map(
    existingCellStates.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell])
  );
  const previousCell = previousCellLookup.get(getCellKey(input.rowIndex, columnKey));
  const delaySourceCell = getDelaySourceCellForDecision(
    columnPermissions,
    input.rowIndex,
    columnKey,
    previousCellLookup
  );
  const previousRawValue = previousCell?.formula ?? previousCell?.value ?? "";
  const decision = getCellEditDecision({
    role: actor.role,
    userId: actor.id,
    columnKey,
    columnPermissions,
    ownership,
    currentValue: previousRawValue,
    delaySourceCell,
    memberEditLockAt: viewSetting?.memberEditLockAt ?? null
  });

  if (!decision.allowed) {
    throw new SheetRuleError(decision.reason ?? "You cannot edit this cell.");
  }

  const editedCell: CellState = {
    rowIndex: input.rowIndex,
    columnKey,
    value: normalizedInput.value,
    formula: normalizedInput.formula,
    computedValue: normalizedInput.value
  };

  const nextCellsWithoutComputed = upsertEditedCell(existingCellStates, editedCell);
  const recalculated = recalculateCells(nextCellsWithoutComputed);
  const nextCells = mergeRecalculatedCells(nextCellsWithoutComputed, recalculated);
  const violations = evaluateConditionalRules({
    cells: nextCells,
    rules: conditionalRules
  });

  if (violations.length > 0) {
    throw new SheetRuleError(violations[0].message);
  }

  const editedComputedValue =
    nextCells.find(
      (cell) => cell.rowIndex === input.rowIndex && cell.columnKey === columnKey
    )?.computedValue ?? normalizedInput.value;

  await prisma.$transaction(
    async (tx) => {
      const liveOwnership = await tx.rowOwnership.findUnique({
        where: { sheetId_rowIndex: { sheetId: input.sheetId, rowIndex: input.rowIndex } },
        include: { owner: { select: { name: true } } }
      });
      const liveCell = await tx.cell.findUnique({
        where: {
          sheetId_rowIndex_columnKey: {
            sheetId: input.sheetId,
            rowIndex: input.rowIndex,
            columnKey
          }
        },
        select: { value: true, formula: true }
      });
      const livePermission = columnPermissions.find((item) => item.columnKey === columnKey);
      const liveViewSetting = await tx.sheetViewSetting.findUnique({
        where: { sheetId: input.sheetId },
        select: { memberEditLockAt: true }
      });
      const liveDelaySourceCell = livePermission?.memberEditDelaySourceColumnKey
        ? await tx.cell.findUnique({
            where: {
              sheetId_rowIndex_columnKey: {
                sheetId: input.sheetId,
                rowIndex: input.rowIndex,
                columnKey: livePermission.memberEditDelaySourceColumnKey
              }
            },
            select: {
              value: true,
              formula: true,
              updatedAt: true
            }
          })
        : null;

      const liveDecision = getCellEditDecision({
        role: actor.role,
        userId: actor.id,
        columnKey,
        columnPermissions,
        ownership: liveOwnership
          ? {
              rowIndex: input.rowIndex,
              ownerId: liveOwnership.ownerId,
              ownerName: liveOwnership.owner.name
            }
          : null,
        currentValue: liveCell?.formula ?? liveCell?.value ?? "",
        delaySourceCell: liveDelaySourceCell,
        memberEditLockAt: liveViewSetting?.memberEditLockAt ?? null
      });

      if (!liveDecision.allowed) {
        throw new SheetRuleError(liveDecision.reason ?? "This row was locked by another user.");
      }

      await tx.sheetRow.upsert({
        where: { sheetId_rowIndex: { sheetId: input.sheetId, rowIndex: input.rowIndex } },
        create: {
          sheetId: input.sheetId,
          rowIndex: input.rowIndex,
          lastEditedById: actor.id
        },
        update: {
          lastEditedById: actor.id
        }
      });

      await tx.cell.upsert({
        where: {
          sheetId_rowIndex_columnKey: {
            sheetId: input.sheetId,
            rowIndex: input.rowIndex,
            columnKey
          }
        },
        create: {
          sheetId: input.sheetId,
          rowIndex: input.rowIndex,
          columnKey,
          value: normalizedInput.value,
          formula: normalizedInput.formula,
          computedValue: editedComputedValue,
          updatedById: actor.id
        },
        update: {
          value: normalizedInput.value,
          formula: normalizedInput.formula,
          computedValue: editedComputedValue,
          updatedById: actor.id
        }
      });

      const formulaCellsToRefresh = nextCells.filter(
        (cell) =>
          cell.formula &&
          !(cell.rowIndex === input.rowIndex && cell.columnKey === columnKey)
      );

      for (const cell of formulaCellsToRefresh) {
        await tx.cell.update({
          where: {
            sheetId_rowIndex_columnKey: {
              sheetId: input.sheetId,
              rowIndex: cell.rowIndex,
              columnKey: cell.columnKey
            }
          },
          data: {
            computedValue: cell.computedValue ?? ""
          }
        });
      }

      if (
        actor.role === Role.MEMBER &&
        liveDecision.willClaimRow &&
        !liveOwnership &&
        hasClaimableValue(editedCell)
      ) {
        await tx.rowOwnership.create({
          data: {
            sheetId: input.sheetId,
            rowIndex: input.rowIndex,
            ownerId: actor.id
          }
        });

        await tx.auditLog.create({
          data: {
            sheetId: input.sheetId,
            actorId: actor.id,
            action: AuditAction.ROW_CLAIMED,
            rowIndex: input.rowIndex,
            message: `${actor.name} claimed row ${input.rowIndex}.`
          }
        });
      }

      await tx.auditLog.create({
        data: {
          sheetId: input.sheetId,
          actorId: actor.id,
          action: AuditAction.CELL_UPDATED,
          rowIndex: input.rowIndex,
          columnKey,
          message: `${actor.name} updated ${columnKey}${input.rowIndex}.`,
          metadata: {
            previousValue: previousCell?.formula ?? previousCell?.value ?? "",
            value: normalizedInput.formula ?? normalizedInput.value,
            previousComputedValue: previousCell?.computedValue ?? previousCell?.value ?? "",
            formula: normalizedInput.formula,
            previousFormula: previousCell?.formula ?? null,
            computedValue: editedComputedValue
          }
        }
      });
    },
    {
      maxWait: 10000,
      timeout: 30000
    }
  );

  return getSheetSnapshot(input.sheetId, actor);
}

export async function bulkUpdateCells(
  actor: Actor,
  input: BulkUpdateCellInput
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { bulkUpdateRealtimeCells } = await import("./rtdb-service");
    return bulkUpdateRealtimeCells(actor, input);
  }

  const normalizedUpdates = input.updates.map((update) => ({
    rowIndex: update.rowIndex,
    columnKey: assertColumnKey(update.columnKey),
    value: update.value
  }));

  if (normalizedUpdates.length === 0) {
    return getSheetSnapshot(input.sheetId, actor);
  }

  for (const update of normalizedUpdates) {
    if (!isValidRowIndex(update.rowIndex)) {
      throw new SheetRuleError("Rows must be between 1 and 1000.");
    }
  }

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  const [
    columnPermissions,
    ownerships,
    validationRules,
    conditionalRules,
    existingCells,
    viewSetting
  ] =
    await Promise.all([
      getPermissionStates(input.sheetId),
      prisma.rowOwnership.findMany({
        where: {
          sheetId: input.sheetId,
          rowIndex: { in: [...new Set(normalizedUpdates.map((update) => update.rowIndex))] }
        },
        include: { owner: { select: { name: true } } }
      }),
      prisma.validationRule.findMany({
        where: { sheetId: input.sheetId, enabled: true }
      }),
      getConditionalRules(input.sheetId),
      prisma.cell.findMany({
        where: { sheetId: input.sheetId },
        select: {
          rowIndex: true,
          columnKey: true,
          value: true,
          formula: true,
          computedValue: true,
          updatedAt: true
        }
      }),
      prisma.sheetViewSetting.findUnique({
        where: { sheetId: input.sheetId },
        select: { memberEditLockAt: true }
      })
    ]);

  const ownershipLookup = new Map(
    ownerships.map((ownership) => [
      ownership.rowIndex,
      {
        rowIndex: ownership.rowIndex,
        ownerId: ownership.ownerId,
        ownerName: ownership.owner.name,
        updatedAt: ownership.updatedAt.toISOString()
      } satisfies RowOwnershipState
    ])
  );

  const existingCellStates = normalizeExistingCells(existingCells);
  const previousCellLookup = new Map(
    existingCellStates.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell])
  );
  const editedCells: CellState[] = [];

  for (const update of normalizedUpdates) {
    const ownership = ownershipLookup.get(update.rowIndex) ?? null;
    const previousCell = previousCellLookup.get(getCellKey(update.rowIndex, update.columnKey));
    const delaySourceCell = getDelaySourceCellForDecision(
      columnPermissions,
      update.rowIndex,
      update.columnKey,
      previousCellLookup
    );
    const decision = getCellEditDecision({
      role: actor.role,
      userId: actor.id,
      columnKey: update.columnKey,
      columnPermissions,
      ownership,
      currentValue: previousCell?.formula ?? previousCell?.value ?? "",
      delaySourceCell,
      memberEditLockAt: viewSetting?.memberEditLockAt ?? null
    });

    if (!decision.allowed) {
      throw new SheetRuleError(
        `${update.columnKey}${update.rowIndex}: ${decision.reason ?? "You cannot edit this cell."}`
      );
    }

    const validationDecision = validateAllowedValue({
      role: actor.role,
      columnKey: update.columnKey,
      nextValue: update.value,
      validationRules: validationRules.map(mapValidationRule)
    });

    if (!validationDecision.valid) {
      throw new SheetRuleError(
        `${update.columnKey}${update.rowIndex}: ${
          validationDecision.reason ?? "The value is not allowed."
        }`
      );
    }

    const normalizedInput = normalizeCellInput(update.value);
    editedCells.push({
      rowIndex: update.rowIndex,
      columnKey: update.columnKey,
      value: normalizedInput.value,
      formula: normalizedInput.formula,
      computedValue: normalizedInput.value
    });
  }

  const nextCellsWithoutComputed = upsertEditedCells(existingCellStates, editedCells);
  const recalculated = recalculateCells(nextCellsWithoutComputed);
  const nextCells = mergeRecalculatedCells(nextCellsWithoutComputed, recalculated);
  const violations = evaluateConditionalRules({
    cells: nextCells,
    rules: conditionalRules
  });

  if (violations.length > 0) {
    throw new SheetRuleError(violations[0].message);
  }

  const computedLookup = new Map(
    nextCells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell.computedValue ?? ""])
  );
  const touchedRows = [...new Set(normalizedUpdates.map((update) => update.rowIndex))];
  const rowsToClaim =
    actor.role === Role.MEMBER
      ? touchedRows.filter((rowIndex) =>
          editedCells.some((cell) => {
            if (cell.rowIndex !== rowIndex || ownershipLookup.has(rowIndex)) {
              return false;
            }

            const previousCell = previousCellLookup.get(getCellKey(cell.rowIndex, cell.columnKey));
            const delaySourceCell = getDelaySourceCellForDecision(
              columnPermissions,
              cell.rowIndex,
              cell.columnKey,
              previousCellLookup
            );
            const decision = getCellEditDecision({
              role: actor.role,
              userId: actor.id,
              columnKey: cell.columnKey,
              columnPermissions,
              ownership: ownershipLookup.get(rowIndex) ?? null,
              currentValue: previousCell?.formula ?? previousCell?.value ?? "",
              delaySourceCell,
              memberEditLockAt: viewSetting?.memberEditLockAt ?? null
            });

            return decision.willClaimRow && hasClaimableValue(cell);
          })
        )
      : [];

  const editedCellKeys = new Set(
    editedCells.map((cell) => getCellKey(cell.rowIndex, cell.columnKey))
  );
  const formulaCellsToRefresh = nextCells.filter(
    (cell) => cell.formula && !editedCellKeys.has(getCellKey(cell.rowIndex, cell.columnKey))
  );

  await upsertBulkSheetRows(input.sheetId, touchedRows, actor.id);

  if (rowsToClaim.length > 0) {
    await claimBulkRows(input.sheetId, rowsToClaim, actor.id);
  }

  await upsertBulkCells(input.sheetId, editedCells, computedLookup, actor.id);
  await refreshBulkFormulaCells(input.sheetId, formulaCellsToRefresh);

  if (editedCells.length <= DETAILED_BULK_AUDIT_LIMIT) {
    await prisma.auditLog.createMany({
      data: editedCells.map((cell) => {
        const cellKey = getCellKey(cell.rowIndex, cell.columnKey);
        const previousCell = previousCellLookup.get(cellKey);
        const computedValue = computedLookup.get(cellKey) ?? "";

        return {
          sheetId: input.sheetId,
          actorId: actor.id,
          action: AuditAction.CELL_UPDATED,
          rowIndex: cell.rowIndex,
          columnKey: cell.columnKey,
          message: `${actor.name} updated ${cell.columnKey}${cell.rowIndex}.`,
          metadata: {
            previousValue: previousCell?.formula ?? previousCell?.value ?? "",
            value: cell.formula ?? cell.value,
            previousComputedValue: previousCell?.computedValue ?? previousCell?.value ?? "",
            computedValue,
            previousFormula: previousCell?.formula ?? null,
            formula: cell.formula ?? null,
            bulk: editedCells.length > 1
          }
        };
      })
    });
  } else {
    await prisma.auditLog.create({
      data: {
        sheetId: input.sheetId,
        actorId: actor.id,
        action: AuditAction.CELL_UPDATED,
        message: `${actor.name} pasted ${editedCells.length} cells.`,
        metadata: getBulkAuditMetadata(editedCells)
      }
    });
  }

  return getSheetSnapshot(input.sheetId, actor);
}

export async function updateCellFormats(
  actor: Actor,
  input: UpdateCellFormatsInput
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { updateRealtimeCellFormats } = await import("./rtdb-service");
    return updateRealtimeCellFormats(actor, input);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can format cells.", 403);
  }

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

  if (targetColumns.length === 0) {
    throw new SheetRuleError("Select at least one column.");
  }

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  await prisma.$transaction(
    async (tx) => {
      const where = {
        sheetId: input.sheetId,
        rowIndex: { gte: startRow, lte: endRow },
        columnKey: { in: targetColumns }
      };

      if (input.clear) {
        await tx.cellFormat.deleteMany({ where });
      } else {
        const patch = normalizeFormatPatch(input.format ?? {});
        const existingFormats = await tx.cellFormat.findMany({
          where,
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
        });
        const existingLookup = new Map(
          existingFormats.map((format) => [
            getCellKey(format.rowIndex, format.columnKey),
            normalizeExistingCellFormat(format)
          ])
        );
        const nextFormats: Array<{
          sheetId: string;
          rowIndex: number;
          columnKey: ColumnKey;
          bold: boolean;
          italic: boolean;
          underline: boolean;
          textColor: string | null;
          backgroundColor: string | null;
          horizontalAlign: CellFormatState["horizontalAlign"];
        }> = [];

        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
          for (const columnKey of targetColumns) {
            const currentFormat =
              existingLookup.get(getCellKey(rowIndex, columnKey)) ?? createDefaultCellFormat();
            const nextFormat = mergeCellFormat(currentFormat, patch);

            if (!isDefaultCellFormat(nextFormat)) {
              nextFormats.push({
                sheetId: input.sheetId,
                rowIndex,
                columnKey,
                bold: nextFormat.bold,
                italic: nextFormat.italic,
                underline: nextFormat.underline,
                textColor: nextFormat.textColor,
                backgroundColor: nextFormat.backgroundColor,
                horizontalAlign: nextFormat.horizontalAlign
              });
            }
          }
        }

        await tx.cellFormat.deleteMany({ where });

        if (nextFormats.length > 0) {
          await tx.cellFormat.createMany({ data: nextFormats });
        }
      }

      const rangeLabel = `${targetColumns[0]}${startRow}:${
        targetColumns[targetColumns.length - 1]
      }${endRow}`;

      await tx.auditLog.create({
        data: {
          sheetId: input.sheetId,
          actorId: actor.id,
          action: AuditAction.CELL_FORMAT_UPDATED,
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
      });
    },
    {
      maxWait: 10000,
      timeout: 30000
    }
  );

  return getSheetSnapshot(input.sheetId, actor);
}

export async function updateColumnRuleSettings(
  actor: Actor,
  input: UpdateColumnRuleSettingsInput
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { updateRealtimeColumnRuleSettings } = await import("./rtdb-service");
    return updateRealtimeColumnRuleSettings(actor, input);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can update column rules.", 403);
  }

  const columnKey = assertColumnKey(input.columnKey);

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  const claimRowOnEdit = input.editableByMember && input.claimRowOnEdit;
  const matchHighlightTerms = normalizeMatchHighlightTerms(input.matchHighlightTerms);
  const memberEditDelayMinutes = normalizeDelayMinutes(input.memberEditDelayMinutes);
  const memberEditDelaySourceColumnKey =
    input.memberEditDelaySourceColumnKey &&
    memberEditDelayMinutes > 0 &&
    input.memberEditDelaySourceColumnKey !== columnKey
      ? assertColumnKey(input.memberEditDelaySourceColumnKey)
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.columnPermission.upsert({
      where: {
        sheetId_columnKey: {
          sheetId: input.sheetId,
          columnKey
        }
      },
      create: {
        sheetId: input.sheetId,
        columnKey,
        editableByMember: input.editableByMember,
        claimRowOnEdit,
        memberWriteOnce: input.memberWriteOnce,
        memberEditDelaySourceColumnKey,
        memberEditDelayMinutes:
          input.editableByMember && memberEditDelaySourceColumnKey
            ? memberEditDelayMinutes
            : 0,
        duplicateHighlight: input.duplicateHighlight,
        matchHighlightTerms
      },
      update: {
        editableByMember: input.editableByMember,
        claimRowOnEdit,
        memberWriteOnce: input.memberWriteOnce,
        memberEditDelaySourceColumnKey,
        memberEditDelayMinutes:
          input.editableByMember && memberEditDelaySourceColumnKey
            ? memberEditDelayMinutes
            : 0,
        duplicateHighlight: input.duplicateHighlight,
        matchHighlightTerms
      }
    });

    await tx.auditLog.create({
      data: {
        sheetId: input.sheetId,
        actorId: actor.id,
        action: AuditAction.COLUMN_PERMISSION_UPDATED,
        columnKey,
        message: `${actor.name} updated rules for column ${columnKey}.`,
        metadata: {
          editableByMember: input.editableByMember,
          claimRowOnEdit,
          memberWriteOnce: input.memberWriteOnce,
          memberEditDelaySourceColumnKey,
          memberEditDelayMinutes:
            input.editableByMember && memberEditDelaySourceColumnKey
              ? memberEditDelayMinutes
              : 0,
          duplicateHighlight: input.duplicateHighlight,
          matchHighlightTerms
        }
      }
    });
  });

  return getSheetSnapshot(input.sheetId, actor);
}

export async function updateSheetViewSettings(
  actor: Actor,
  input: UpdateSheetViewSettingsInput
): Promise<SheetViewSettingState> {
  if (isRealtimeDatabaseSource()) {
    const { updateRealtimeSheetViewSettings } = await import("./rtdb-service");
    return updateRealtimeSheetViewSettings(actor, input);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can save sheet view settings.", 403);
  }

  const columnWidths =
    input.columnWidths === undefined
      ? undefined
      : normalizeSheetColumnWidths(input.columnWidths);
  const condensedView =
    input.condensedView === undefined
      ? undefined
      : normalizeSheetCondensedView(input.condensedView);
  const frozenHeaderRowIndex =
    input.frozenHeaderRowIndex === undefined
      ? undefined
      : normalizeSheetFrozenHeaderRowIndex(input.frozenHeaderRowIndex);
  const frozenHeaderColumnKey =
    input.frozenHeaderColumnKey === undefined
      ? undefined
      : normalizeSheetFrozenHeaderColumnKey(input.frozenHeaderColumnKey);
  const memberEditLockAt =
    input.memberEditLockAt === undefined
      ? undefined
      : input.memberEditLockAt
        ? new Date(input.memberEditLockAt)
        : null;
  const alternateRowColors = input.alternateRowColors;
  const alternateOddColor =
    input.alternateOddColor === undefined
      ? undefined
      : normalizeHexColor(input.alternateOddColor) ??
        DEFAULT_SHEET_VIEW_SETTING.alternateOddColor;
  const alternateEvenColor =
    input.alternateEvenColor === undefined
      ? undefined
      : normalizeHexColor(input.alternateEvenColor) ??
        DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor;
  const fontSize =
    input.fontSize === undefined ? undefined : normalizeSheetFontSize(input.fontSize);

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  const updateData = {
    ...(alternateRowColors === undefined ? {} : { alternateRowColors }),
    ...(alternateOddColor === undefined ? {} : { alternateOddColor }),
    ...(alternateEvenColor === undefined ? {} : { alternateEvenColor }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(columnWidths === undefined ? {} : { columnWidths }),
    ...(condensedView === undefined ? {} : { condensedView }),
    ...(frozenHeaderRowIndex === undefined ? {} : { frozenHeaderRowIndex }),
    ...(frozenHeaderColumnKey === undefined ? {} : { frozenHeaderColumnKey }),
    ...(memberEditLockAt === undefined ? {} : { memberEditLockAt })
  };

  const viewSetting = await prisma.sheetViewSetting.upsert({
    where: { sheetId: input.sheetId },
    create: {
      sheetId: input.sheetId,
      alternateRowColors:
        alternateRowColors ?? DEFAULT_SHEET_VIEW_SETTING.alternateRowColors,
      alternateOddColor: alternateOddColor ?? DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
      alternateEvenColor: alternateEvenColor ?? DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
      fontSize: fontSize ?? DEFAULT_SHEET_VIEW_SETTING.fontSize,
      columnWidths: columnWidths ?? DEFAULT_SHEET_VIEW_SETTING.columnWidths,
      condensedView: condensedView ?? DEFAULT_SHEET_VIEW_SETTING.condensedView,
      frozenHeaderRowIndex:
        frozenHeaderRowIndex ?? DEFAULT_SHEET_VIEW_SETTING.frozenHeaderRowIndex,
      frozenHeaderColumnKey:
        frozenHeaderColumnKey ?? DEFAULT_SHEET_VIEW_SETTING.frozenHeaderColumnKey,
      memberEditLockAt:
        memberEditLockAt ?? DEFAULT_SHEET_VIEW_SETTING.memberEditLockAt
    },
    update: updateData,
    select: {
      alternateRowColors: true,
      alternateOddColor: true,
      alternateEvenColor: true,
      fontSize: true,
      columnWidths: true,
      condensedView: true,
      frozenHeaderRowIndex: true,
      frozenHeaderColumnKey: true,
      memberEditLockAt: true
    }
  });

  return {
    alternateRowColors: viewSetting.alternateRowColors,
    alternateOddColor:
      normalizeHexColor(viewSetting.alternateOddColor) ??
      DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
    alternateEvenColor:
      normalizeHexColor(viewSetting.alternateEvenColor) ??
      DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
    fontSize: normalizeSheetFontSize(viewSetting.fontSize),
    columnWidths: normalizeSheetColumnWidths(viewSetting.columnWidths),
    condensedView: normalizeSheetCondensedView(viewSetting.condensedView),
    frozenHeaderRowIndex: normalizeSheetFrozenHeaderRowIndex(
      viewSetting.frozenHeaderRowIndex
    ),
    frozenHeaderColumnKey: normalizeSheetFrozenHeaderColumnKey(
      viewSetting.frozenHeaderColumnKey
    ),
    memberEditLockAt: viewSetting.memberEditLockAt?.toISOString() ?? null
  };
}

export async function unlockAllRows(actor: Actor, sheetId: string): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { unlockAllRealtimeRows } = await import("./rtdb-service");
    return unlockAllRealtimeRows(actor, sheetId);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can unlock rows.", 403);
  }

  await prisma.$transaction(async (tx) => {
    const result = await tx.rowOwnership.deleteMany({ where: { sheetId } });

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.ROW_UNLOCKED,
        message: `${actor.name} unlocked all rows.`,
        metadata: {
          unlockedRows: result.count
        }
      }
    });
  });

  return getSheetSnapshot(sheetId, actor);
}

export async function resetRow(actor: Actor, sheetId: string, rowIndex: number): Promise<SheetSnapshot> {
  return resetRows(actor, sheetId, [rowIndex]);
}

export async function resetRows(
  actor: Actor,
  sheetId: string,
  rowIndexes: number[]
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { resetRealtimeRows } = await import("./rtdb-service");
    return resetRealtimeRows(actor, sheetId, rowIndexes);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can reset rows.", 403);
  }

  const targetRowIndexes = normalizeRowIndexes(rowIndexes);

  await prisma.sheet.findUniqueOrThrow({
    where: { id: sheetId },
    select: { id: true }
  });

  const [columnPermissions, existingCells] = await Promise.all([
    getPermissionStates(sheetId),
    prisma.cell.findMany({
      where: { sheetId },
      select: {
        rowIndex: true,
        columnKey: true,
        value: true,
        formula: true,
        computedValue: true,
        updatedAt: true
      }
    })
  ]);
  const resetColumns = columnPermissions
    .filter((permission) => permission.editableByMember)
    .map((permission) => permission.columnKey);

  await prisma.rowOwnership.deleteMany({
    where: { sheetId, rowIndex: { in: targetRowIndexes } }
  });

  if (resetColumns.length > 0) {
    const resetCells: CellState[] = targetRowIndexes.flatMap((rowIndex) =>
      resetColumns.map((columnKey) => ({
        rowIndex,
        columnKey,
        value: "",
        formula: null,
        computedValue: ""
      }))
    );
    const existingCellStates = normalizeExistingCells(existingCells);
    const nextCellsWithoutComputed = upsertEditedCells(existingCellStates, resetCells);
    const recalculated = recalculateCells(nextCellsWithoutComputed);
    const nextCells = mergeRecalculatedCells(nextCellsWithoutComputed, recalculated);
    const computedLookup = new Map(
      nextCells.map((cell) => [getCellKey(cell.rowIndex, cell.columnKey), cell.computedValue ?? ""])
    );
    const resetCellKeys = new Set(
      resetCells.map((cell) => getCellKey(cell.rowIndex, cell.columnKey))
    );
    const formulaCellsToRefresh = nextCells.filter(
      (cell) => cell.formula && !resetCellKeys.has(getCellKey(cell.rowIndex, cell.columnKey))
    );

    await upsertBulkSheetRows(sheetId, targetRowIndexes, actor.id);
    await upsertBulkCells(sheetId, resetCells, computedLookup, actor.id);
    await refreshBulkFormulaCells(sheetId, formulaCellsToRefresh);
  }

  await prisma.auditLog.create({
    data: {
      sheetId,
      actorId: actor.id,
      action: AuditAction.CELL_UPDATED,
      rowIndex: targetRowIndexes.length === 1 ? targetRowIndexes[0] : null,
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
  });

  return getSheetSnapshot(sheetId, actor);
}

export async function getCellHistory(
  actor: Actor,
  input: GetCellHistoryInput
): Promise<CellHistoryEntryState[]> {
  if (isRealtimeDatabaseSource()) {
    const { getRealtimeCellHistory } = await import("./rtdb-service");
    return getRealtimeCellHistory(actor, input);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can view cell history.", 403);
  }

  const columnKey = assertColumnKey(input.columnKey);

  if (!isValidRowIndex(input.rowIndex)) {
    throw new SheetRuleError("Rows must be between 1 and 1000.");
  }

  await prisma.sheet.findUniqueOrThrow({
    where: { id: input.sheetId },
    select: { id: true }
  });

  const logs = await prisma.auditLog.findMany({
    where: {
      sheetId: input.sheetId,
      rowIndex: input.rowIndex,
      columnKey,
      action: { in: [AuditAction.CELL_UPDATED, AuditAction.CELL_FORMAT_UPDATED] }
    },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    actorName: log.actor?.name ?? null,
    message: log.message,
    previousValue: getMetadataString(log.metadata, "previousValue"),
    value: getMetadataString(log.metadata, "value"),
    previousComputedValue: getMetadataString(log.metadata, "previousComputedValue"),
    computedValue: getMetadataString(log.metadata, "computedValue"),
    previousFormula: getMetadataString(log.metadata, "previousFormula"),
    formula: getMetadataString(log.metadata, "formula"),
    createdAt: log.createdAt.toISOString()
  }));
}

export async function unlockRow(
  actor: Actor,
  sheetId: string,
  rowIndex: number
): Promise<SheetSnapshot> {
  return unlockRows(actor, sheetId, [rowIndex]);
}

export async function unlockRows(
  actor: Actor,
  sheetId: string,
  rowIndexes: number[]
): Promise<SheetSnapshot> {
  if (isRealtimeDatabaseSource()) {
    const { unlockRealtimeRows } = await import("./rtdb-service");
    return unlockRealtimeRows(actor, sheetId, rowIndexes);
  }

  if (actor.role !== Role.ADMIN) {
    throw new SheetRuleError("Only admins can unlock rows.", 403);
  }

  const targetRowIndexes = normalizeRowIndexes(rowIndexes);

  await prisma.$transaction(async (tx) => {
    await tx.rowOwnership.deleteMany({
      where: { sheetId, rowIndex: { in: targetRowIndexes } }
    });

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.ROW_UNLOCKED,
        rowIndex: targetRowIndexes.length === 1 ? targetRowIndexes[0] : null,
        message:
          targetRowIndexes.length === 1
            ? `${actor.name} unlocked row ${targetRowIndexes[0]}.`
            : `${actor.name} unlocked ${targetRowIndexes.length} rows.`,
        metadata: {
          rowIndexes: targetRowIndexes
        }
      }
    });
  });

  return getSheetSnapshot(sheetId, actor);
}
