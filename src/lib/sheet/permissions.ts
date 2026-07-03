import { Role } from "@/generated/prisma/enums";
import type { ColumnKey } from "@/lib/constants";
import type { AppRole, ColumnPermissionState, RowOwnershipState } from "./types";

export interface CellEditDecisionInput {
  role: AppRole;
  userId: string;
  columnKey: ColumnKey;
  columnPermissions: ColumnPermissionState[];
  ownership?: RowOwnershipState | null;
  currentValue?: string | null;
  delaySourceCell?: {
    value?: string | null;
    formula?: string | null;
    updatedAt?: Date | string | null;
  } | null;
  now?: Date;
}

export interface CellEditDecision {
  allowed: boolean;
  reason: string | null;
  willClaimRow: boolean;
  state: "editable" | "admin" | "admin-only" | "owned-by-you" | "owned-by-other";
}

function getCellRawValue(cell: CellEditDecisionInput["delaySourceCell"]): string {
  return String(cell?.formula ?? cell?.value ?? "").trim();
}

function getDelayTimestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

function getMemberDelayBlockReason(
  permission: ColumnPermissionState,
  input: CellEditDecisionInput
): string | null {
  const sourceColumnKey = permission.memberEditDelaySourceColumnKey;
  const delayMinutes = Math.max(0, permission.memberEditDelayMinutes);

  if (!sourceColumnKey || delayMinutes <= 0) {
    return null;
  }

  if (!getCellRawValue(input.delaySourceCell)) {
    return `Column ${input.columnKey} opens after column ${sourceColumnKey} has a value.`;
  }

  const sourceUpdatedAt = getDelayTimestamp(input.delaySourceCell?.updatedAt);

  if (!sourceUpdatedAt) {
    return `Column ${input.columnKey} opens after column ${sourceColumnKey} is saved.`;
  }

  const now = input.now?.getTime() ?? Date.now();
  const opensAt = sourceUpdatedAt + delayMinutes * 60_000;

  if (now < opensAt) {
    const minutesRemaining = Math.max(1, Math.ceil((opensAt - now) / 60_000));

    return `Column ${input.columnKey} opens in ${minutesRemaining} minute${
      minutesRemaining === 1 ? "" : "s"
    } after column ${sourceColumnKey}.`;
  }

  return null;
}

export function getCellEditDecision(input: CellEditDecisionInput): CellEditDecision {
  if (input.role === Role.ADMIN) {
    return {
      allowed: true,
      reason: null,
      willClaimRow: false,
      state: "admin"
    };
  }

  const permission = input.columnPermissions.find(
    (item) => item.columnKey === input.columnKey
  );

  if (!permission?.editableByMember) {
    return {
      allowed: false,
      reason: "This column is admin-only.",
      willClaimRow: false,
      state: "admin-only"
    };
  }

  if (permission.memberWriteOnce && input.currentValue?.trim()) {
    return {
      allowed: false,
      reason: "This column locks for members after the first entry.",
      willClaimRow: false,
      state: "admin-only"
    };
  }

  if (input.ownership && input.ownership.ownerId !== input.userId) {
    return {
      allowed: false,
      reason: `This row is owned by ${input.ownership.ownerName ?? "another member"}.`,
      willClaimRow: false,
      state: "owned-by-other"
    };
  }

  const delayBlockReason = getMemberDelayBlockReason(permission, input);

  if (delayBlockReason) {
    return {
      allowed: false,
      reason: delayBlockReason,
      willClaimRow: false,
      state: "admin-only"
    };
  }

  if (input.ownership?.ownerId === input.userId) {
    return {
      allowed: true,
      reason: null,
      willClaimRow: false,
      state: "owned-by-you"
    };
  }

  return {
    allowed: true,
    reason: null,
    willClaimRow: permission.claimRowOnEdit,
    state: "editable"
  };
}
