import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { SheetRuleError, unlockRow } from "@/lib/sheet/service";

const unlockSchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.number().int().min(1).max(1000)
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = unlockSchema.parse(await request.json());
    const snapshot = await unlockRow(user, payload.sheetId, payload.rowIndex);
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
