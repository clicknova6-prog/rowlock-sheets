import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { assertColumnKey } from "@/lib/constants";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, claimRowForEdit } from "@/lib/sheet/service";

const claimSchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.number().int().min(1).max(1000),
  columnKey: z.string().length(1),
  sourceClientId: z.string().min(1).max(128).optional()
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = claimSchema.parse(await request.json());
    const columnKey = assertColumnKey(payload.columnKey);
    const snapshot = await claimRowForEdit(user, {
      sheetId: payload.sheetId,
      rowIndex: payload.rowIndex,
      columnKey
    });

    await publishSheetRealtimeEvent({
      type: "row-claimed",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      rowIndexes: [payload.rowIndex],
      updates: [{ row: payload.rowIndex, col: columnKey }],
      sourceClientId: payload.sourceClientId
    });

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid row claim request." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to claim this row." }, { status: 500 });
  }
}
