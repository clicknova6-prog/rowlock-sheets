import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { COLUMN_KEYS, MAX_ROWS } from "@/lib/constants";
import { mirrorSheetConfigToRealtimeDatabase } from "@/lib/firebase/realtime-sheet-mirror";
import { SheetRuleError, updateSheetViewSettings } from "@/lib/sheet/service";
import { getSheetSnapshot } from "@/lib/sheet/snapshot";

const updateSheetViewSettingsSchema = z.object({
  sheetId: z.string().min(1),
  columnWidths: z.record(z.string(), z.number().int().min(1).max(5000)).optional(),
  condensedView: z.boolean().optional(),
  frozenHeaderRowIndex: z.number().int().min(1).max(MAX_ROWS).nullable().optional(),
  frozenHeaderColumnKey: z.enum(COLUMN_KEYS).nullable().optional()
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = updateSheetViewSettingsSchema.parse(await request.json());
    const viewSetting = await updateSheetViewSettings(user, payload);
    const snapshot = await getSheetSnapshot(payload.sheetId, user);

    await mirrorSheetConfigToRealtimeDatabase(snapshot);

    return NextResponse.json({ viewSetting });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid sheet view settings payload." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to save sheet view settings." }, { status: 500 });
  }
}
