import { jwtVerify, SignJWT } from "jose";
import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/sheet/types";

export const SESSION_COOKIE = "rowlock_session";
const SESSION_DURATION = "7d";

interface SessionClaims {
  email: string;
  name: string;
  role: Role;
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters.");
  }

  return new TextEncoder().encode(secret);
}

export async function signSessionToken(user: Actor): Promise<string> {
  return new SignJWT({
    email: user.email,
    name: user.name,
    role: user.role
  } satisfies SessionClaims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_DURATION)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<(Actor & { id: string }) | null> {
  try {
    const result = await jwtVerify<SessionClaims>(token, getSecret());

    if (!result.payload.sub) {
      return null;
    }

    return {
      id: result.payload.sub,
      email: result.payload.email,
      name: result.payload.name,
      role: result.payload.role
    };
  } catch {
    return null;
  }
}
