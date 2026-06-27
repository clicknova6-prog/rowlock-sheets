import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { SheetRuleError, bulkUpdateCells, updateCell } from "@/lib/sheet/service";

const updateCellSchema = z.object({
  sheetId: z.string().min(1),
  rowIndex: z.number().int().min(1).max(1000),
  columnKey: z.string().length(1),
  value: z.string().max(10000)
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
    .max(10000)
});

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const body = await request.json();
    const snapshot =
      "updates" in body
        ? await bulkUpdateCells(user, bulkUpdateSchema.parse(body))
        : await updateCell(user, updateCellSchema.parse(body));
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
