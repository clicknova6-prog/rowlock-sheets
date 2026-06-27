import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/sheet/types";
import { SESSION_COOKIE, signSessionToken, verifySessionToken } from "./token";
import { getFirebaseActorByUid } from "@/lib/firebase/users";

export async function createSession(user: Actor): Promise<void> {
  const token = await signSessionToken(user);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function readSession(): Promise<(Actor & { id: string }) | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  return verifySessionToken(token);
}

export async function getCurrentUser(): Promise<Actor | null> {
  const session = await readSession();

  if (!session) {
    return null;
  }

  return (await getFirebaseActorByUid(session.id)) ?? session;
}

export async function getUserFromSessionToken(token: string): Promise<Actor | null> {
  const session = await verifySessionToken(token);

  if (!session) {
    return null;
  }

  return (await getFirebaseActorByUid(session.id)) ?? session;
}

export async function requireUser(): Promise<Actor> {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function requireAdmin(): Promise<Actor> {
  const user = await requireUser();

  if (user.role !== Role.ADMIN) {
    redirect("/");
  }

  return user;
}

export function isAdminRole(role: Role): boolean {
  return role === Role.ADMIN;
}
