import type { ColumnKey } from "@/lib/constants";
import type { SheetGridRow } from "./types";

export type SheetRealtimeEventType =
  | "cells-changed"
  | "format-changed"
  | "row-claimed"
  | "row-unlocked";

export interface SheetRealtimeCellUpdate {
  row: number;
  col: ColumnKey;
}

export interface SheetRealtimeEvent {
  id?: string;
  type: SheetRealtimeEventType;
  sheetId: string;
  actorId: string;
  actorName?: string | null;
  sourceClientId?: string | null;
  rowIndexes?: number[];
  cellCount?: number;
  updates?: SheetRealtimeCellUpdate[];
  rows?: SheetGridRow[];
  requiresRefresh?: boolean;
}
