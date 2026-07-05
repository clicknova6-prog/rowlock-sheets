import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";
import { isRealtimeDatabaseSource } from "@/lib/data-source";
import { createMariaDbPoolConfig } from "@/lib/db-config";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createUnavailablePrismaClient(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("Cloud SQL is unavailable while SHEET_DATA_SOURCE=rtdb.");
      }
    }
  ) as PrismaClient;
}

function createPrismaClient() {
  if (isRealtimeDatabaseSource()) {
    return createUnavailablePrismaClient();
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const adapter = new PrismaMariaDb(createMariaDbPoolConfig(databaseUrl));
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
