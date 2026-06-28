import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { assertColumnKey, isValidRowIndex } from "@/lib/constants";
import type { Actor, SheetGridRow, SheetSnapshot } from "@/lib/sheet/types";
import type {
  SheetRealtimeCellUpdate,
  SheetRealtimeEvent,
  SheetRealtimeEventType
} from "@/lib/sheet/realtime-types";
import { firebaseAdminDb } from "./admin";

const EVENT_MAX_BYTES = 850_000;
const EVENT_TTL_MS = 1000 * 60 * 60 * 24;

interface PublishSheetRealtimeEventInput {
  type: SheetRealtimeEventType;
  sheetId: string;
  actor: Actor;
  snapshot: SheetSnapshot;
  rowIndexes?: number[];
  cellCount?: number;
  updates?: SheetRealtimeCellUpdate[];
  sourceClientId?: string | null;
  requiresRefresh?: boolean;
}

function normalizeRowIndexes(rowIndexes: number[] | undefined): number[] {
  return [...new Set(rowIndexes ?? [])].filter(isValidRowIndex).slice(0, 1000);
}

function getChangedRows(snapshot: SheetSnapshot, rowIndexes: number[]): SheetGridRow[] {
  const wantedRows = new Set(rowIndexes);
  return snapshot.rows.filter((row) => wantedRows.has(row.rowNumber));
}

function normalizeUpdates(
  updates: SheetRealtimeCellUpdate[] | undefined
): SheetRealtimeCellUpdate[] | undefined {
  if (!updates?.length) {
    return undefined;
  }

  return updates.slice(0, 10000).map((update) => ({
    row: update.row,
    col: assertColumnKey(update.col)
  }));
}

function normalizeSourceClientId(sourceClientId: string | null | undefined): string | null {
  if (!sourceClientId || sourceClientId.length > 128) {
    return null;
  }

  return sourceClientId;
}

function estimateBytes(event: SheetRealtimeEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function removeEmptyOptionalFields(event: SheetRealtimeEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined && value !== null)
  );
}

export async function publishSheetRealtimeEvent(
  input: PublishSheetRealtimeEventInput
): Promise<void> {
  if (process.env.ENABLE_FIRESTORE_REALTIME === "false") {
    return;
  }

  const rowIndexes = normalizeRowIndexes(input.rowIndexes);
  const rows = getChangedRows(input.snapshot, rowIndexes);
  const event: SheetRealtimeEvent = {
    type: input.type,
    sheetId: input.sheetId,
    actorId: input.actor.id,
    actorName: input.actor.name,
    sourceClientId: normalizeSourceClientId(input.sourceClientId),
    rowIndexes,
    cellCount: input.cellCount,
    updates: normalizeUpdates(input.updates),
    rows,
    requiresRefresh: input.requiresRefresh ?? rows.length === 0
  };

  const compactEvent =
    estimateBytes(event) <= EVENT_MAX_BYTES
        ? event
      : {
          ...event,
          updates: undefined,
          rows: undefined,
          requiresRefresh: true
        };
  const eventData = removeEmptyOptionalFields(compactEvent);

  try {
    await firebaseAdminDb
      .collection("sheetRealtime")
      .doc(input.sheetId)
      .collection("events")
      .add({
        ...eventData,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + EVENT_TTL_MS)
      });
  } catch (error) {
    console.warn("Unable to publish Firestore sheet realtime event.", error);
  }
}
