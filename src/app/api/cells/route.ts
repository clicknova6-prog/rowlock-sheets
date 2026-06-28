import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { assertColumnKey } from "@/lib/constants";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, bulkUpdateCells, updateCell } from "@/lib/sheet/service";

const sourceClientIdSchema = z.string().min(1).max(128).optional();

const updateCellSchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.number().int().min(1).max(1000),
  columnKey: z.string().length(1),
  value: z.string().max(10000),
  sourceClientId: sourceClientIdSchema
});

const bulkUpdateSchema = z.object({
  sheetId: z.string().min(1),
  updates: z
    .array(
      z.object({
        rowIndex: z.number().int().min(1).max(1000),
        columnKey: z.string().length(1),
        value: z.string().max(10000)
      })
    )
    .min(1)
    .max(10000),
  sourceClientId: sourceClientIdSchema
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = await request.json();

    if ("updates" in body) {
      const payload = bulkUpdateSchema.parse(body);
      const snapshot = await bulkUpdateCells(user, payload);

      await publishSheetRealtimeEvent({
        type: "cells-changed",
        sheetId: payload.sheetId,
        actor: user,
        snapshot,
        rowIndexes: payload.updates.map((update) => update.rowIndex),
        cellCount: payload.updates.length,
        updates: payload.updates.map((update) => ({
          row: update.rowIndex,
          col: assertColumnKey(update.columnKey)
        })),
        sourceClientId: payload.sourceClientId
      });

      return NextResponse.json({ snapshot });
    }

    const payload = updateCellSchema.parse(body);
    const snapshot = await updateCell(user, payload);

    await publishSheetRealtimeEvent({
      type: "cells-changed",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      rowIndexes: [payload.rowIndex],
      cellCount: 1,
      updates: [{ row: payload.rowIndex, col: assertColumnKey(payload.columnKey) }],
      sourceClientId: payload.sourceClientId
    });

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid cell update payload." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to save the cell." }, { status: 500 });
  }
}
