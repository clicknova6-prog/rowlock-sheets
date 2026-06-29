"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, KeyRound, Trash2 } from "lucide-react";
import {
  changeMemberPasswordAction,
  deleteMemberAction,
  type MemberManagementActionState
} from "@/app/actions/admin-actions";
import type { AdminMemberState } from "@/lib/sheet/types";

const initialState: MemberManagementActionState = {
  ok: false,
  message: ""
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function Feedback({ state }: { state: MemberManagementActionState }) {
  if (!state.message) {
    return null;
  }

  return (
    <span
      className={
        state.ok
          ? "inline-flex min-h-7 items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50 px-2 text-xs font-medium text-teal-800 dark:border-teal-900/70 dark:bg-teal-950/40 dark:text-teal-100"
          : "inline-flex min-h-7 items-center rounded-md border border-rose-300 bg-rose-50 px-2 text-xs font-medium text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200"
      }
    >
      {state.ok ? <CheckCircle2 size={14} /> : null}
      {state.message}
    </span>
  );
}

function PasswordSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[color:var(--line)] px-2 text-xs font-semibold transition hover:bg-[color:var(--panel-muted)] disabled:cursor-not-allowed disabled:opacity-70"
      disabled={pending}
      type="submit"
    >
      <KeyRound size={14} />
      {pending ? "Saving..." : "Change"}
    </button>
  );
}

function DeleteSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-rose-300 px-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-70 dark:border-rose-900 dark:text-rose-200 dark:hover:bg-rose-950/40"
      disabled={pending}
      type="submit"
    >
      <Trash2 size={14} />
      {pending ? "Deleting..." : "Delete"}
    </button>
  );
}

function PasswordResetForm({ member }: { member: AdminMemberState }) {
  const [state, formAction] = useActionState(changeMemberPasswordAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
    }
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="space-y-2">
      <input name="memberId" type="hidden" value={member.id} />
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          autoComplete="new-password"
          className="focus-ring h-9 w-full min-w-40 rounded-md border border-[color:var(--line)] bg-transparent px-2 text-xs"
          minLength={8}
          name="password"
          placeholder="New password"
          required
          type="password"
        />
        <PasswordSubmitButton />
      </div>
      <Feedback state={state} />
    </form>
  );
}

function DeleteMemberForm({ member }: { member: AdminMemberState }) {
  const [state, formAction] = useActionState(deleteMemberAction, initialState);

  return (
    <form
      action={formAction}
      className="space-y-2"
      onSubmit={(event) => {
        if (!window.confirm(`Delete ${member.email}? This removes their login and row ownership.`)) {
          event.preventDefault();
        }
      }}
    >
      <input name="memberId" type="hidden" value={member.id} />
      <DeleteSubmitButton />
      <Feedback state={state} />
    </form>
  );
}

export function MemberManagement({ members }: { members: AdminMemberState[] }) {
  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[color:var(--line)] px-3 py-4 text-sm text-[color:var(--text-muted)]">
        No members have been created yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[color:var(--line)]">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-[color:var(--panel-muted)]">
          <tr>
            <th className="px-3 py-2">Member</th>
            <th className="px-3 py-2">Activity</th>
            <th className="px-3 py-2">Password</th>
            <th className="px-3 py-2">Delete</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr className="border-t border-[color:var(--line)] align-top" key={member.id}>
              <td className="px-3 py-3">
                <div className="font-medium">{member.name}</div>
                <div className="text-xs text-[color:var(--text-muted)]">{member.email}</div>
                <div className="mt-1 text-xs text-[color:var(--text-muted)]">
                  Added {formatDate(member.createdAt)}
                </div>
              </td>
              <td className="px-3 py-3 text-xs text-[color:var(--text-muted)]">
                <div>{member.ownedRowCount} owned rows</div>
                <div>{member.updatedCellCount} edited cells</div>
                <div>{member.editedRowCount} edited rows</div>
              </td>
              <td className="px-3 py-3">
                <PasswordResetForm member={member} />
              </td>
              <td className="px-3 py-3">
                <DeleteMemberForm member={member} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
