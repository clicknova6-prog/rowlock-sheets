import type { DecodedIdToken } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { Role } from "@/generated/prisma/enums";
import { isRealtimeDatabaseSource } from "@/lib/data-source";
import type { Actor, AdminMemberState } from "@/lib/sheet/types";
import { firebaseAdminAuth, firebaseAdminDb } from "./admin";
import {
  deleteUserProfileFromRealtimeDatabase,
  mirrorUserProfileToRealtimeDatabase
} from "./realtime-sheet-mirror";

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

function timestampToIso(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  return new Date().toISOString();
}

async function syncPrismaUser(actor: Actor): Promise<void> {
  if (isRealtimeDatabaseSource()) {
    return;
  }

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

async function getMemberProfileFromFirestore(memberId: string): Promise<Actor> {
  const userSnapshot = await firebaseAdminDb.collection("users").doc(memberId).get();

  if (!userSnapshot.exists) {
    throw new Error("Member was not found.");
  }

  const profile = userSnapshot.data() as FirebaseUserProfile;

  if (!profile.email || normalizeRole(profile.role) !== Role.MEMBER) {
    throw new Error("Member was not found.");
  }

  return {
    id: memberId,
    email: profile.email.toLowerCase(),
    name: profile.name ?? profile.email,
    role: Role.MEMBER
  };
}

async function listFirebaseMembersFromFirestore(): Promise<AdminMemberState[]> {
  const snapshot = await firebaseAdminDb.collection("users").where("role", "==", Role.MEMBER).get();

  return snapshot.docs
    .map((doc) => {
      const data = doc.data() as FirebaseUserProfile & {
        createdAt?: unknown;
        updatedAt?: unknown;
      };
      const email = data.email?.toLowerCase();

      if (!email) {
        return null;
      }

      return {
        id: doc.id,
        email,
        name: data.name ?? email,
        role: Role.MEMBER,
        createdAt: timestampToIso(data.createdAt),
        updatedAt: timestampToIso(data.updatedAt),
        ownedRowCount: 0,
        updatedCellCount: 0,
        editedRowCount: 0
      } satisfies AdminMemberState;
    })
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt) || a!.email.localeCompare(b!.email)) as AdminMemberState[];
}

export async function createFirebaseMember({
  email,
  name,
  password
}: CreateFirebaseMemberInput): Promise<Actor> {
  const normalizedEmail = email.trim().toLowerCase();
  const displayName = name.trim() || normalizedEmail.split("@")[0] || "Member";

  if (!isRealtimeDatabaseSource()) {
    const { prisma } = await import("@/lib/db");
    const existingPrismaUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true }
    });

    if (existingPrismaUser) {
      throw new Error("A member with this email already exists.");
    }
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
    await mirrorUserProfileToRealtimeDatabase(actor);
    return actor;
  } catch (error) {
    await Promise.allSettled([
      userRef.delete(),
      firebaseAdminAuth.deleteUser(userRecord.uid)
    ]);
    throw error;
  }
}

export async function listFirebaseMembers(): Promise<AdminMemberState[]> {
  if (isRealtimeDatabaseSource()) {
    return listFirebaseMembersFromFirestore();
  }

  const { prisma } = await import("@/lib/db");
  const members = await prisma.user.findMany({
    where: { role: Role.MEMBER },
    orderBy: [{ createdAt: "desc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          ownedRows: true,
          updatedCells: true,
          editedRows: true
        }
      }
    }
  });

  return members.map((member) => ({
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
    ownedRowCount: member._count.ownedRows,
    updatedCellCount: member._count.updatedCells,
    editedRowCount: member._count.editedRows
  }));
}

export async function updateFirebaseMemberPassword(
  memberId: string,
  password: string
): Promise<Actor> {
  if (isRealtimeDatabaseSource()) {
    const member = await getMemberProfileFromFirestore(memberId);

    try {
      await firebaseAdminAuth.updateUser(member.id, {
        password,
        disabled: false
      });
    } catch (error) {
      if (!isFirebaseAuthError(error, "auth/user-not-found")) {
        throw error;
      }

      await firebaseAdminAuth.createUser({
        uid: member.id,
        email: member.email,
        password,
        displayName: member.name,
        disabled: false,
        emailVerified: false
      });
    }

    await firebaseAdminDb.collection("users").doc(member.id).set(
      {
        email: member.email,
        name: member.name,
        role: member.role,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    await mirrorUserProfileToRealtimeDatabase(member);

    return member;
  }

  const { prisma } = await import("@/lib/db");
  const member = await prisma.user.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true
    }
  });

  if (!member || member.role !== Role.MEMBER) {
    throw new Error("Member was not found.");
  }

  try {
    await firebaseAdminAuth.updateUser(member.id, {
      password,
      disabled: false
    });
  } catch (error) {
    if (!isFirebaseAuthError(error, "auth/user-not-found")) {
      throw error;
    }

    await firebaseAdminAuth.createUser({
      uid: member.id,
      email: member.email,
      password,
      displayName: member.name,
      disabled: false,
      emailVerified: false
    });
  }

  await firebaseAdminDb.collection("users").doc(member.id).set(
    {
      email: member.email,
      name: member.name,
      role: member.role,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  await prisma.user.update({
    where: { id: member.id },
    data: { updatedAt: new Date() }
  });
  await mirrorUserProfileToRealtimeDatabase(member);

  return {
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.role
  };
}

export async function deleteFirebaseMember(memberId: string): Promise<Actor> {
  if (isRealtimeDatabaseSource()) {
    const member = await getMemberProfileFromFirestore(memberId);

    try {
      await firebaseAdminAuth.deleteUser(member.id);
    } catch (error) {
      if (!isFirebaseAuthError(error, "auth/user-not-found")) {
        throw error;
      }
    }

    await firebaseAdminDb.collection("users").doc(member.id).delete();
    await deleteUserProfileFromRealtimeDatabase(member.id);

    return member;
  }

  const { prisma } = await import("@/lib/db");
  const member = await prisma.user.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true
    }
  });

  if (!member || member.role !== Role.MEMBER) {
    throw new Error("Member was not found.");
  }

  try {
    await firebaseAdminAuth.deleteUser(member.id);
  } catch (error) {
    if (!isFirebaseAuthError(error, "auth/user-not-found")) {
      throw error;
    }
  }

  await firebaseAdminDb.collection("users").doc(member.id).delete();
  await deleteUserProfileFromRealtimeDatabase(member.id);
  await prisma.$transaction(
    async (tx) => {
      await tx.rowOwnership.deleteMany({ where: { ownerId: member.id } });
      await tx.sheetRow.updateMany({
        where: { lastEditedById: member.id },
        data: { lastEditedById: null }
      });
      await tx.cell.updateMany({
        where: { updatedById: member.id },
        data: { updatedById: null }
      });
      await tx.cell.updateMany({
        where: { lockedBy: member.id },
        data: { lockedBy: null }
      });
      await tx.user.delete({ where: { id: member.id } });
    },
    {
      maxWait: 10000,
      timeout: 20000
    }
  );

  return {
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.role
  };
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
  await mirrorUserProfileToRealtimeDatabase(actor);

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
