import type { DecodedIdToken } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/sheet/types";
import { firebaseAdminAuth, firebaseAdminDb } from "./admin";

interface FirebaseUserProfile {
  email?: string;
  name?: string;
  role?: Role;
}

interface CreateFirebaseMemberInput {
  email: string;
  name: string;
  password: string;
}

function normalizeRole(value: unknown): Role {
  return value === Role.ADMIN ? Role.ADMIN : Role.MEMBER;
}

function getAdminEmails(): Set<string> {
  return new Set(
    (process.env.FIREBASE_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getDisplayName(token: DecodedIdToken): string {
  const email = token.email?.toLowerCase() ?? "";
  return token.name || email.split("@")[0] || "User";
}

async function syncPrismaUser(actor: Actor): Promise<void> {
  const { prisma } = await import("@/lib/db");

  await prisma.user.upsert({
    where: { id: actor.id },
    create: {
      id: actor.id,
      email: actor.email,
      name: actor.name,
      role: actor.role,
      passwordHash: "firebase-auth"
    },
    update: {
      email: actor.email,
      name: actor.name,
      role: actor.role
    }
  });
}

function isFirebaseAuthError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function createFirebaseMember({
  email,
  name,
  password
}: CreateFirebaseMemberInput): Promise<Actor> {
  const normalizedEmail = email.trim().toLowerCase();
  const displayName = name.trim() || normalizedEmail.split("@")[0] || "Member";
  const { prisma } = await import("@/lib/db");
  const existingPrismaUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true }
  });

  if (existingPrismaUser) {
    throw new Error("A member with this email already exists.");
  }

  try {
    await firebaseAdminAuth.getUserByEmail(normalizedEmail);
    throw new Error("A Firebase Auth user with this email already exists.");
  } catch (error) {
    if (!isFirebaseAuthError(error, "auth/user-not-found")) {
      throw error;
    }
  }

  const userRecord = await firebaseAdminAuth.createUser({
    email: normalizedEmail,
    password,
    displayName,
    disabled: false,
    emailVerified: false
  });
  const actor: Actor = {
    id: userRecord.uid,
    email: normalizedEmail,
    name: displayName,
    role: Role.MEMBER
  };
  const userRef = firebaseAdminDb.collection("users").doc(actor.id);

  try {
    await userRef.set({
      email: actor.email,
      name: actor.name,
      role: actor.role,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await syncPrismaUser(actor);
    return actor;
  } catch (error) {
    await Promise.allSettled([
      userRef.delete(),
      firebaseAdminAuth.deleteUser(userRecord.uid)
    ]);
    throw error;
  }
}

export async function getOrCreateFirebaseActor(token: DecodedIdToken): Promise<Actor> {
  const uid = token.uid;
  const email = token.email?.toLowerCase();

  if (!email) {
    throw new Error("Firebase user must have an email address.");
  }

  const userRef = firebaseAdminDb.collection("users").doc(uid);
  const userSnapshot = await userRef.get();
  const profile = userSnapshot.exists ? (userSnapshot.data() as FirebaseUserProfile) : null;
  const role =
    profile?.role ?? (getAdminEmails().has(email) ? Role.ADMIN : Role.MEMBER);
  const actor: Actor = {
    id: uid,
    email,
    name: profile?.name ?? getDisplayName(token),
    role: normalizeRole(role)
  };

  await userRef.set(
    {
      email: actor.email,
      name: actor.name,
      role: actor.role,
      updatedAt: FieldValue.serverTimestamp(),
      ...(userSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
    },
    { merge: true }
  );

  await syncPrismaUser(actor);

  return actor;
}

export async function getFirebaseActorByUid(uid: string): Promise<Actor | null> {
  const userSnapshot = await firebaseAdminDb.collection("users").doc(uid).get();

  if (!userSnapshot.exists) {
    return null;
  }

  const profile = userSnapshot.data() as FirebaseUserProfile;

  if (!profile.email) {
    return null;
  }

  const actor: Actor = {
    id: uid,
    email: profile.email.toLowerCase(),
    name: profile.name ?? profile.email,
    role: normalizeRole(profile.role)
  };

  await syncPrismaUser(actor);

  return actor;
}
