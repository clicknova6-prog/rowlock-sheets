import type { Role, RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import type { ColumnKey } from "@/lib/constants";

export type AppRole = Role;

export interface Actor {
  id: string;
  name: string;
  email: string;
  role: AppRole;
}

export interface AdminMemberState extends Actor {
  createdAt: string;
  updatedAt: string;
  ownedRowCount: number;
  updatedCellCount: number;
  editedRowCount: number;
}

export interface ColumnPermissionState {
  columnKey: ColumnKey;
  editableByMember: boolean;
  claimRowOnEdit: boolean;
  memberWriteOnce: boolean;
  duplicateHighlight: boolean;
  matchHighlightTerms: string[];
}

export interface RowOwnershipState {
  rowIndex: number;
  ownerId: string;
  ownerName?: string | null;
  updatedAt?: string | null;
}

export interface CellState {
  rowIndex: number;
  columnKey: ColumnKey;
  value: string;
  formula?: string | null;
  computedValue?: string | null;
}

export type HorizontalAlign = "left" | "center" | "right";

export interface CellFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textColor: string | null;
  backgroundColor: string | null;
  horizontalAlign: HorizontalAlign | null;
}

export interface CellFormatEntryState extends CellFormatState {
  rowIndex: number;
  columnKey: ColumnKey;
}

export interface CellFormatPatch {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  textColor?: string | null;
  backgroundColor?: string | null;
  horizontalAlign?: HorizontalAlign | null;
}

export interface SheetViewSettingState {
  alternateRowColors: boolean;
  alternateOddColor: string;
  alternateEvenColor: string;
  fontSize: number;
  columnWidths: Partial<Record<ColumnKey, number>>;
  condensedView: boolean;
  frozenHeaderRowIndex: number | null;
}

export interface ValidationRuleState {
  id?: string;
  columnKey: ColumnKey;
  name: string;
  allowedValues: string[];
  enabled: boolean;
}

export interface RuleConditionState {
  id?: string;
  columnKey: ColumnKey;
  operator: RuleOperator;
  joinOperator: RuleJoinOperator;
  values: string[];
}

export interface ConditionalRuleState {
  id: string;
  name: string;
  description?: string | null;
  limitCount: number;
  enabled: boolean;
  conditions: RuleConditionState[];
}

export interface SheetGridRow {
  rowNumber: number;
  ownerId: string | null;
  ownerName: string | null;
  lastEditedBy: string | null;
  updatedAt: string | null;
  __computed: Record<ColumnKey, string>;
  __formula: Record<ColumnKey, boolean>;
  __editable: Record<ColumnKey, boolean>;
  __lockReason: Record<ColumnKey, string | null>;
  __format: Record<ColumnKey, CellFormatState>;
  __duplicateHighlight: boolean;
  __matchHighlight: boolean;
  A: string;
  B: string;
  C: string;
  D: string;
  E: string;
  F: string;
  G: string;
  H: string;
  I: string;
  J: string;
  K: string;
  L: string;
  M: string;
  N: string;
  O: string;
  P: string;
  Q: string;
  R: string;
  S: string;
  T: string;
  U: string;
  V: string;
  W: string;
  X: string;
  Y: string;
  Z: string;
}

export interface AuditLogState {
  id: string;
  action: string;
  actorName: string | null;
  rowIndex: number | null;
  columnKey: string | null;
  message: string;
  metadata?: unknown;
  createdAt: string;
}

export interface CellHistoryEntryState {
  id: string;
  action: string;
  actorName: string | null;
  message: string;
  previousValue: string | null;
  value: string | null;
  previousComputedValue: string | null;
  computedValue: string | null;
  previousFormula: string | null;
  formula: string | null;
  createdAt: string;
}

export interface SheetSnapshot {
  currentUser: Actor;
  sheet: {
    id: string;
    name: string;
  };
  columns: ColumnKey[];
  rows: SheetGridRow[];
  viewSetting: SheetViewSettingState;
  columnPermissions: ColumnPermissionState[];
  validationRules: ValidationRuleState[];
  conditionalRules: ConditionalRuleState[];
  auditLogs: AuditLogState[];
}
