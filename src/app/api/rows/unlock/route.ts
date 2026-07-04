import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { mirrorSheetRowsToRealtimeDatabase } from "@/lib/firebase/realtime-sheet-mirror";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, unlockRows } from "@/lib/sheet/service";

const unlockSchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.number().int().min(1).max(1000).optional(),
  rowIndexes: z.array(z.number().int().min(1).max(1000)).min(1).max(500).optional(),
  sourceClientId: z.string().min(1).max(128).optional()
}).refine((payload) => payload.rowIndex !== undefined || payload.rowIndexes !== undefined);

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = unlockSchema.parse(await request.json());
    const rowIndexes = payload.rowIndexes ?? [payload.rowIndex!];
    const snapshot = await unlockRows(user, payload.sheetId, rowIndexes);

    await publishSheetRealtimeEvent({
      type: "row-unlocked",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      rowIndexes,
      sourceClientId: payload.sourceClientId
    });
    await mirrorSheetRowsToRealtimeDatabase(
      snapshot,
      snapshot.rows.filter((row) => rowIndexes.includes(row.rowNumber))
    );

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid unlock request." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to unlock this row." }, { status: 500 });
  }
}
