"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, UserPlus } from "lucide-react";
import {
  createMemberAction,
  type CreateMemberActionState
} from "@/app/actions/admin-actions";

const initialState: CreateMemberActionState = {
  ok: false,
  message: ""
};

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[color:var(--accent)] px-3 text-sm font-semibold text-[color:var(--accent-contrast)] transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
      disabled={pending}
      type="submit"
    >
      <UserPlus size={16} />
      {pending ? "Creating..." : "Add member"}
    </button>
  );
}

export function CreateMemberForm() {
  const [state, formAction] = useActionState(createMemberAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
    }
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <label>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
            Name
          </span>
          <input
            autoComplete="name"
            className="focus-ring h-10 w-full rounded-md border border-[color:var(--line)] bg-transparent px-3 text-sm"
            maxLength={120}
            name="name"
            placeholder="Member name"
            type="text"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
            Email
          </span>
          <input
            autoComplete="email"
            className="focus-ring h-10 w-full rounded-md border border-[color:var(--line)] bg-transparent px-3 text-sm"
            name="email"
            placeholder="member@example.com"
            required
            type="email"
          />
        </label>
      </div>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
          Temporary password
        </span>
        <input
          autoComplete="new-password"
          className="focus-ring h-10 w-full rounded-md border border-[color:var(--line)] bg-transparent px-3 text-sm"
          minLength={8}
          name="password"
          placeholder="At least 8 characters"
          required
          type="password"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton />
        {state.message ? (
          <span
            className={
              state.ok
                ? "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50 px-2 text-xs font-medium text-teal-800 dark:border-teal-900/70 dark:bg-teal-950/40 dark:text-teal-100"
                : "inline-flex min-h-8 items-center rounded-md border border-rose-300 bg-rose-50 px-2 text-xs font-medium text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200"
            }
          >
            {state.ok ? <CheckCircle2 size={14} /> : null}
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
