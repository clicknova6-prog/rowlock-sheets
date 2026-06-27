"use client";

import { Moon, Sun } from "lucide-react";
import { useAppTheme } from "@/components/theme/theme-provider";

export function ThemeToggle() {
  const { theme, setTheme } = useAppTheme();
  const isDark = theme === "dark";

  return (
    <button
      aria-label="Toggle theme"
      className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-md border border-[color:var(--line)] bg-[color:var(--panel)] text-[color:var(--text)] transition hover:bg-[color:var(--panel-muted)]"
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title="Toggle theme"
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
