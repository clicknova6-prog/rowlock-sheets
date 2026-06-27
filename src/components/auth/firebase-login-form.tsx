"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase/client";

function getFirebaseAuthMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    switch ((error as { code: string }).code) {
      case "auth/invalid-credential":
      case "auth/user-not-found":
      case "auth/wrong-password":
        return "Invalid email or password.";
      case "auth/too-many-requests":
        return "Too many attempts. Please wait and try again.";
      case "auth/user-disabled":
        return "This account has been disabled.";
      default:
        return "Unable to sign in with Firebase.";
    }
  }

  return "Unable to sign in.";
}

export function FirebaseLoginForm({ initialError }: { initialError?: string | null }) {
  const router = useRouter();
  const [error, setError] = useState(initialError ?? null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
        const idToken = await credential.user.getIdToken();
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken })
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? "Unable to create a session.");
        }

        router.replace("/");
        router.refresh();
      } catch (submitError) {
        const firebaseMessage = getFirebaseAuthMessage(submitError);
        setError(
          firebaseMessage === "Unable to sign in." && submitError instanceof Error
            ? submitError.message
            : firebaseMessage
        );
      }
    });
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      {error ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Email</span>
        <input
          autoComplete="email"
          className="focus-ring h-11 w-full rounded-md border border-[color:var(--line)] bg-transparent px-3"
          name="email"
          required
          type="email"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Password</span>
        <input
          autoComplete="current-password"
          className="focus-ring h-11 w-full rounded-md border border-[color:var(--line)] bg-transparent px-3"
          name="password"
          required
          type="password"
        />
      </label>
      <button
        className="focus-ring inline-flex h-11 w-full items-center justify-center rounded-md bg-[color:var(--accent)] px-4 font-semibold text-white transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={isPending}
        type="submit"
      >
        {isPending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
