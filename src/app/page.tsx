import { AppShell } from "@/components/app-shell";
import { SpreadsheetWorkspace } from "@/components/spreadsheet/spreadsheet-workspace";
import { requireUser } from "@/lib/auth/session";
import { createDemoSnapshot } from "@/lib/sheet/demo-data";
import { getFirstSheetSnapshot } from "@/lib/sheet/snapshot";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (process.env.SKIP_AUTH === "true") {
    const snapshot = createDemoSnapshot();

    return (
      <AppShell user={snapshot.currentUser}>
        <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
          <SpreadsheetWorkspace demoMode initialSnapshot={snapshot} />
        </main>
      </AppShell>
    );
  }

  const user = await requireUser();
  const snapshot = await getFirstSheetSnapshot(user);

  return (
    <AppShell user={user}>
      <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
        {snapshot ? (
          <SpreadsheetWorkspace initialSnapshot={snapshot} />
        ) : (
          <section className="rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-6">
            <h1 className="text-lg font-semibold">No sheet found</h1>
            <p className="mt-2 text-sm text-[color:var(--text-muted)]">
              Run the seed command to create the demo sheet.
            </p>
          </section>
        )}
      </main>
    </AppShell>
  );
}
