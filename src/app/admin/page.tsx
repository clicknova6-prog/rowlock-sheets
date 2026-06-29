import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { AppShell } from "@/components/app-shell";
import { requireAdmin } from "@/lib/auth/session";
import { listFirebaseMembers } from "@/lib/firebase/users";
import { getFirstSheetSnapshot } from "@/lib/sheet/snapshot";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireAdmin();
  const [snapshot, members] = await Promise.all([
    getFirstSheetSnapshot(user),
    listFirebaseMembers()
  ]);

  return (
    <AppShell user={user}>
      <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
        {snapshot ? (
          <AdminDashboard members={members} snapshot={snapshot} />
        ) : (
          <section className="rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-6">
            <h1 className="text-lg font-semibold">No sheet found</h1>
          </section>
        )}
      </main>
    </AppShell>
  );
}
