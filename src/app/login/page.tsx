import { Grid3X3 } from "lucide-react";
import { FirebaseLoginForm } from "@/components/auth/firebase-login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? decodeURIComponent(params.error) : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[color:var(--app-bg)] p-4 text-[color:var(--text)]">
      <section className="w-full max-w-md rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-6 shadow-soft-panel">
        <div className="mb-6 flex items-center gap-3">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-[color:var(--accent)] text-white">
            <Grid3X3 size={22} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Rowlock Sheets</h1>
            <p className="text-sm text-[color:var(--text-muted)]">Sign in</p>
          </div>
        </div>

        <FirebaseLoginForm initialError={error} />
      </section>
    </main>
  );
}
