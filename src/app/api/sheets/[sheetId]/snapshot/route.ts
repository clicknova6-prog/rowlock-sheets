import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getSheetSnapshot } from "@/lib/sheet/snapshot";
import { SheetRuleError } from "@/lib/sheet/service";

interface SnapshotRouteContext {
  params: Promise<{
    sheetId: string;
  }>;
}

export async function GET(
  _request: Request,
  context: SnapshotRouteContext
): Promise<NextResponse> {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const { sheetId } = await context.params;
    const snapshot = await getSheetSnapshot(sheetId, user);
    return NextResponse.json({ snapshot });
  } catch (error) {
    if (error instanceof SheetRuleError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ error: "Unable to load the latest sheet." }, { status: 500 });
  }
}
