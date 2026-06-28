import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, unlockAllRows } from "@/lib/sheet/service";

const unlockAllSchema = z.object({
  sheetId: z.string().min(1),
  sourceClientId: z.string().min(1).max(128).optional()
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = unlockAllSchema.parse(await request.json());
    const snapshot = await unlockAllRows(user, payload.sheetId);

    await publishSheetRealtimeEvent({
      type: "row-unlocked",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      requiresRefresh: true,
      sourceClientId: payload.sourceClientId
    });

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid unlock request." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to unlock rows." }, { status: 500 });
  }
}
