import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { SheetRuleError, updateSheetColumnWidths } from "@/lib/sheet/service";

const updateColumnWidthsSchema = z.object({
  sheetId: z.string().min(1),
  columnWidths: z.record(z.string(), z.number().int().min(1).max(5000))
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = updateColumnWidthsSchema.parse(await request.json());
    const viewSetting = await updateSheetColumnWidths(user, payload);

    return NextResponse.json({ viewSetting });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid sheet view settings payload." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to save column widths." }, { status: 500 });
  }
}
