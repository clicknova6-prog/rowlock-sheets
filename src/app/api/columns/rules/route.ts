import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { mirrorSheetConfigToRealtimeDatabase } from "@/lib/firebase/realtime-sheet-mirror";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, updateColumnRuleSettings } from "@/lib/sheet/service";

const updateColumnRulesSchema = z.object({
  sheetId: z.string().min(1),
  columnKey: z.string().length(1),
  editableByMember: z.boolean(),
  claimRowOnEdit: z.boolean(),
  memberWriteOnce: z.boolean(),
  memberEditDelaySourceColumnKey: z.string().length(1).nullable().optional(),
  memberEditDelayMinutes: z.number().int().min(0).max(1440).optional(),
  duplicateHighlight: z.boolean(),
  matchHighlightTerms: z.array(z.string()).max(500).optional(),
  sourceClientId: z.string().min(1).max(128).optional()
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = updateColumnRulesSchema.parse(await request.json());
    const snapshot = await updateColumnRuleSettings(user, payload);

    await publishSheetRealtimeEvent({
      type: "format-changed",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      requiresRefresh: true,
      sourceClientId: payload.sourceClientId
    });
    await mirrorSheetConfigToRealtimeDatabase(snapshot);

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid column rule payload." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to save column rules." }, { status: 500 });
  }
}
