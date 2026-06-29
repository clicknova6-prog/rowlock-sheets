import type { ColumnKey } from "@/lib/constants";
import type { SheetGridRow } from "./types";

export interface JoinSheetPayload {
  sheetId: string;
}

export interface CellUpdatePayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
  value: string;
  userId?: string;
}

export interface CellUpdateItemPayload {
  row: number;
  col: ColumnKey;
  value: string;
}

export interface CellsUpdatePayload {
  sheetId: string;
  updates: CellUpdateItemPayload[];
  userId?: string;
}

export interface CellFocusPayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
  userId?: string;
}

export type CellBlurPayload = CellFocusPayload;
export type RowClaimPayload = CellFocusPayload;

export interface CellChangedPayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
  value: string;
  userId: string;
  rows?: SheetGridRow[];
}

export interface CellsChangedPayload {
  sheetId: string;
  updates: CellUpdateItemPayload[];
  userId: string;
  rows?: SheetGridRow[];
  persisted?: boolean;
}

export interface RowClaimedPayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
  userId: string;
  rows: SheetGridRow[];
}

export interface CellLockedPayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
  userId: string;
  userColor: string;
}

export interface CellUnlockedPayload {
  sheetId: string;
  row: number;
  col: ColumnKey;
}

export interface SheetLocksPayload {
  sheetId: string;
  locks: CellLockedPayload[];
}

export interface CellErrorPayload {
  sheetId?: string;
  row?: number;
  col?: ColumnKey;
  message: string;
}

export interface ServerToClientEvents {
  "cell-changed": (payload: CellChangedPayload) => void;
  "cells-changed": (payload: CellsChangedPayload) => void;
  "row-claimed": (payload: RowClaimedPayload) => void;
  "cell-locked": (payload: CellLockedPayload) => void;
  "cell-unlocked": (payload: CellUnlockedPayload) => void;
  "sheet-locks": (payload: SheetLocksPayload) => void;
  "cell-error": (payload: CellErrorPayload) => void;
}

export interface ClientToServerEvents {
  "join-sheet": (payload: JoinSheetPayload | string) => void;
  "cell-update": (payload: CellUpdatePayload) => void;
  "cells-update": (payload: CellsUpdatePayload) => void;
  "row-claim": (payload: RowClaimPayload) => void;
  "cell-focus": (payload: CellFocusPayload) => void;
  "cell-blur": (payload: CellBlurPayload) => void;
}
