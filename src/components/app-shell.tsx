import Link from "next/link";
import { Grid3X3, LogOut, Settings } from "lucide-react";
import { logoutAction } from "@/app/actions/auth-actions";
import { Role } from "@/generated/prisma/enums";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import type { Actor } from "@/lib/sheet/types";

export function AppShell({
  user,
  children
}: {
  user: Actor;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[color:var(--app-bg)] text-[color:var(--text)]">
      <header className="sticky top-0 z-20 border-b border-[color:var(--line)] bg-[color:var(--panel)]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1800px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md bg-[color:var(--accent)] text-white"
              href="/"
              title="Spreadsheet"
            >
              <Grid3X3 size={20} />
            </Link>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Rowlock Sheets</p>
              <p className="truncate text-xs text-[color:var(--text-muted)]">
                {user.name} · {user.role === Role.ADMIN ? "admin" : "member"}
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-2">
            {user.role === Role.ADMIN ? (
              <Link
                className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--panel)] transition hover:bg-[color:var(--panel-muted)]"
                href="/admin"
                title="Admin"
              >
                <Settings size={18} />
              </Link>
            ) : null}
            <ThemeToggle />
            <form action={logoutAction}>
              <button
                aria-label="Sign out"
                className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--panel)] transition hover:bg-[color:var(--panel-muted)]"
                title="Sign out"
                type="submit"
              >
                <LogOut size={18} />
              </button>
            </form>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
