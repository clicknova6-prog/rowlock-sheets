import "dotenv/config";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { mirrorSheetSnapshotToRealtimeDatabase } from "@/lib/firebase/realtime-sheet-mirror";
import { getSheetSnapshot } from "@/lib/sheet/snapshot";
import type { Actor } from "@/lib/sheet/types";

async function main(): Promise<void> {
  const sheet = await prisma.sheet.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });

  if (!sheet) {
    throw new Error("No sheet found to mirror.");
  }

  const user = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" },
    where: { role: Role.ADMIN },
    select: {
      id: true,
      email: true,
      name: true,
      role: true
    }
  });

  if (!user) {
    throw new Error("No admin user found to build the SQL snapshot.");
  }

  const actor: Actor = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
  };
  const snapshot = await getSheetSnapshot(sheet.id, actor);

  await mirrorSheetSnapshotToRealtimeDatabase(snapshot, { force: true });
  console.log(`Mirrored sheet ${snapshot.sheet.name} (${snapshot.sheet.id}) to Realtime Database.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
