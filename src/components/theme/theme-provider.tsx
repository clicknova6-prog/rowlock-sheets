"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore
} from "react";

type ThemeMode = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

const STORAGE_KEY = "rowlock-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);
const listeners = new Set<() => void>();
let currentTheme: ThemeMode = "light";

function getPreferredTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const savedTheme = window.localStorage.getItem(STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.classList.toggle("dark", theme === "dark");
}

function emitTheme(theme: ThemeMode): void {
  currentTheme = theme;
  applyTheme(theme);

  for (const listener of listeners) {
    listener();
  }
}

function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  applyTheme(getPreferredTheme());

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemChange = () => {
    const hasSavedTheme = window.localStorage.getItem(STORAGE_KEY);

    if (!hasSavedTheme) {
      emitTheme(mediaQuery.matches ? "dark" : "light");
    }
  };

  mediaQuery.addEventListener("change", handleSystemChange);

  return () => {
    listeners.delete(listener);
    mediaQuery.removeEventListener("change", handleSystemChange);
  };
}

function getThemeSnapshot(): ThemeMode {
  currentTheme = getPreferredTheme();
  return currentTheme;
}

function getServerThemeSnapshot(): ThemeMode {
  return "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot
  );
  const setTheme = useCallback((nextTheme: ThemeMode) => {
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    emitTheme(nextTheme);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme
    }),
    [setTheme, theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useAppTheme must be used within ThemeProvider.");
  }

  return context;
}
