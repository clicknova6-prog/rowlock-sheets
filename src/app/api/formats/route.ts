import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { SheetRuleError, updateCellFormats } from "@/lib/sheet/service";

const sourceClientIdSchema = z.string().min(1).max(128).optional();

const cellFormatPatchSchema = z
  .object({
    bold: z.boolean().nullable().optional(),
    italic: z.boolean().nullable().optional(),
    underline: z.boolean().nullable().optional(),
    textColor: z.string().nullable().optional(),
    backgroundColor: z.string().nullable().optional(),
    horizontalAlign: z.enum(["left", "center", "right"]).nullable().optional()
  })
  .optional();

const updateFormatSchema = z.object({
  sheetId: z.string().min(1),
  startRow: z.number().int().min(1).max(1000),
  endRow: z.number().int().min(1).max(1000),
  startColumnKey: z.string().length(1),
  endColumnKey: z.string().length(1),
  format: cellFormatPatchSchema,
  clear: z.boolean().optional(),
  sourceClientId: sourceClientIdSchema
});

function getRangeRowIndexes(startRow: number, endRow: number): number[] {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const rowIndexes: number[] = [];

  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
    rowIndexes.push(rowIndex);
  }

  return rowIndexes;
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const payload = updateFormatSchema.parse(await request.json());
    const snapshot = await updateCellFormats(user, payload);

    await publishSheetRealtimeEvent({
      type: "format-changed",
      sheetId: payload.sheetId,
      actor: user,
      snapshot,
      rowIndexes: getRangeRowIndexes(payload.startRow, payload.endRow),
      sourceClientId: payload.sourceClientId
    });

    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid format update payload." }, { status: 400 });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to save formatting." }, { status: 500 });
  }
}
