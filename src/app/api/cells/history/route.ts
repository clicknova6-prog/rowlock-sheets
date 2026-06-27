import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { SheetRuleError, getCellHistory } from "@/lib/sheet/service";

const historyQuerySchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.coerce.number().int().min(1).max(1000),
  columnKey: z.string().length(1)
});

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const history = await getCellHistory(user, historyQuerySchema.parse(query));
    return NextResponse.json({ history });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid cell history query." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to load cell history." }, { status: 500 });
  }
}
