import { Role } from "@/generated/prisma/enums";
import type { ColumnKey } from "@/lib/constants";
import type { AppRole, ColumnPermissionState, RowOwnershipState } from "./types";

export interface CellEditDecisionInput {
  role: AppRole;
  userId: string;
  columnKey: ColumnKey;
  columnPermissions: ColumnPermissionState[];
  ownership?: RowOwnershipState | null;
}

export interface CellEditDecision {
  allowed: boolean;
  reason: string | null;
  willClaimRow: boolean;
  state: "editable" | "admin" | "admin-only" | "owned-by-you" | "owned-by-other";
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

  if (input.ownership && input.ownership.ownerId !== input.userId) {
    return {
      allowed: false,
      reason: `This row is owned by ${input.ownership.ownerName ?? "another member"}.`,
      willClaimRow: false,
      state: "owned-by-other"
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
    willClaimRow: true,
    state: "editable"
  };
}
