import { NextResponse } from "next/server";
import { AuditAction } from "@/generated/prisma/enums";
import { createSession, clearSession } from "@/lib/auth/session";
import { isRealtimeDatabaseSource } from "@/lib/data-source";
import { firebaseAdminAuth } from "@/lib/firebase/admin";
import { getOrCreateFirebaseActor } from "@/lib/firebase/users";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { idToken?: unknown };
    const idToken = typeof body.idToken === "string" ? body.idToken : null;

    if (!idToken) {
      return NextResponse.json({ error: "Missing Firebase ID token." }, { status: 400 });
    }

    const decodedToken = await firebaseAdminAuth.verifyIdToken(idToken);
    const actor = await getOrCreateFirebaseActor(decodedToken);
    await createSession(actor);

    if (!isRealtimeDatabaseSource()) {
      try {
        const { prisma } = await import("@/lib/db");
        const sheet = await prisma.sheet.findFirst({ select: { id: true } });

        if (sheet) {
          await prisma.auditLog.create({
            data: {
              sheetId: sheet.id,
              actorId: actor.id,
              action: AuditAction.USER_SIGNED_IN,
              message: `${actor.name} signed in with Firebase.`
            }
          });
        }
      } catch (error) {
        console.warn("Unable to write sign-in audit log.", error);
      }
    }

    return NextResponse.json({ user: actor });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Unable to create a Firebase session." }, { status: 401 });
  }
}

export async function DELETE(): Promise<NextResponse> {
  await clearSession();
  return NextResponse.json({ ok: true });
}
