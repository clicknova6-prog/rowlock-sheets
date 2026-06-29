import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { hash } from "bcryptjs";
import {
  AuditAction,
  PrismaClient,
  Role,
  RuleOperator
} from "../src/generated/prisma/client";
import { COLUMN_KEYS } from "../src/lib/constants";
import { mergeRecalculatedCells, recalculateCells } from "../src/lib/sheet/formulas";
import { createMariaDbPoolConfig } from "../src/lib/db-config";
import type { CellState } from "../src/lib/sheet/types";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const prisma = new PrismaClient({ adapter: new PrismaMariaDb(createMariaDbPoolConfig(databaseUrl)) });

async function resetDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.ruleCondition.deleteMany();
  await prisma.conditionalRule.deleteMany();
  await prisma.validationRule.deleteMany();
  await prisma.rowOwnership.deleteMany();
  await prisma.cell.deleteMany();
  await prisma.cellFormat.deleteMany();
  await prisma.columnPermission.deleteMany();
  await prisma.sheetViewSetting.deleteMany();
  await prisma.sheetRow.deleteMany();
  await prisma.sheet.deleteMany();
  await prisma.user.deleteMany();
}

function buildSeedCells(sheetId: string, adminId: string): Array<{
  sheetId: string;
  rowIndex: number;
  columnKey: string;
  value: string;
  formula?: string | null;
  computedValue?: string | null;
  updatedById: string;
}> {
  const cells: CellState[] = [
    { rowIndex: 1, columnKey: "A", value: "Ashar" },
    { rowIndex: 1, columnKey: "B", value: "10" },
    { rowIndex: 1, columnKey: "D", value: "" },
    { rowIndex: 1, columnKey: "F", value: "" },
    { rowIndex: 1, columnKey: "G", value: "", formula: "=SUM(B1:B3)" },
    { rowIndex: 2, columnKey: "A", value: "Ashar" },
    { rowIndex: 2, columnKey: "B", value: "20" },
    { rowIndex: 2, columnKey: "D", value: "" },
    { rowIndex: 2, columnKey: "F", value: "" },
    { rowIndex: 3, columnKey: "A", value: "Mina" },
    { rowIndex: 3, columnKey: "B", value: "30" },
    { rowIndex: 4, columnKey: "A", value: "Ashar" },
    { rowIndex: 4, columnKey: "D", value: "Closed" },
    { rowIndex: 5, columnKey: "A", value: "Jordan" },
    { rowIndex: 5, columnKey: "C", value: "Admin note" }
  ];

  const recalculated = mergeRecalculatedCells(cells, recalculateCells(cells));

  return recalculated.map((cell) => ({
    sheetId,
    rowIndex: cell.rowIndex,
    columnKey: cell.columnKey,
    value: cell.value,
    formula: cell.formula ?? null,
    computedValue: cell.computedValue ?? cell.value,
    updatedById: adminId
  }));
}

async function main() {
  await resetDatabase();

  const passwordHashAdmin = await hash("Admin123!", 12);
  const passwordHashMember = await hash("Member123!", 12);

  const admin = await prisma.user.create({
    data: {
      email: "admin@example.com",
      name: "Avery Admin",
      passwordHash: passwordHashAdmin,
      role: Role.ADMIN
    }
  });

  const member = await prisma.user.create({
    data: {
      email: "member@example.com",
      name: "Mina Member",
      passwordHash: passwordHashMember,
      role: Role.MEMBER
    }
  });

  const sheet = await prisma.sheet.create({
    data: {
      name: "Operations Tracker",
      createdById: admin.id
    }
  });

  await prisma.columnPermission.createMany({
    data: COLUMN_KEYS.map((columnKey) => ({
      sheetId: sheet.id,
      columnKey,
      editableByMember: ["A", "B", "D", "F", "G", "I", "J"].includes(columnKey),
      claimRowOnEdit: ["A", "B", "D", "F", "G", "I", "J"].includes(columnKey)
    }))
  });

  await prisma.sheetRow.createMany({
    data: [1, 2, 3, 4, 5].map((rowIndex) => ({
      sheetId: sheet.id,
      rowIndex,
      lastEditedById: rowIndex === 2 ? member.id : admin.id
    }))
  });

  await prisma.cell.createMany({
    data: buildSeedCells(sheet.id, admin.id)
  });

  await prisma.sheetViewSetting.create({
    data: {
      sheetId: sheet.id,
      alternateRowColors: true,
      alternateOddColor: "#ffffff",
      alternateEvenColor: "#f8fafc"
    }
  });

  await prisma.cellFormat.createMany({
    data: [
      {
        sheetId: sheet.id,
        rowIndex: 1,
        columnKey: "A",
        bold: true,
        backgroundColor: "#fef3c7"
      },
      {
        sheetId: sheet.id,
        rowIndex: 1,
        columnKey: "B",
        bold: true,
        backgroundColor: "#fef3c7"
      },
      {
        sheetId: sheet.id,
        rowIndex: 5,
        columnKey: "C",
        italic: true,
        textColor: "#be123c"
      }
    ]
  });

  await prisma.rowOwnership.create({
    data: {
      sheetId: sheet.id,
      rowIndex: 2,
      ownerId: member.id
    }
  });

  await prisma.validationRule.create({
    data: {
      sheetId: sheet.id,
      columnKey: "A",
      name: "Approved assignees",
      allowedValues: ["Ashar", "Mina", "Jordan"],
      enabled: true
    }
  });

  await prisma.conditionalRule.create({
    data: {
      sheetId: sheet.id,
      name: "Ashar open case cap",
      description: "Column A contains Ashar while D and F are empty.",
      limitCount: 3,
      enabled: true,
      conditions: {
        create: [
          {
            columnKey: "A",
            operator: RuleOperator.CONTAINS,
            values: ["Ashar"]
          },
          {
            columnKey: "D",
            operator: RuleOperator.EMPTY,
            values: []
          },
          {
            columnKey: "F",
            operator: RuleOperator.EMPTY,
            values: []
          }
        ]
      }
    }
  });

  await prisma.auditLog.createMany({
    data: [
      {
        sheetId: sheet.id,
        actorId: admin.id,
        action: AuditAction.COLUMN_PERMISSION_UPDATED,
        message: "Demo column permissions created."
      },
      {
        sheetId: sheet.id,
        actorId: admin.id,
        action: AuditAction.VALIDATION_RULE_UPDATED,
        message: "Demo allowed values created for column A."
      },
      {
        sheetId: sheet.id,
        actorId: admin.id,
        action: AuditAction.CONDITIONAL_RULE_UPDATED,
        message: "Demo conditional rule created."
      },
      {
        sheetId: sheet.id,
        actorId: member.id,
        action: AuditAction.ROW_CLAIMED,
        rowIndex: 2,
        message: "Mina Member claimed row 2."
      }
    ]
  });

  console.log("Seed complete");
  console.log("Admin: admin@example.com / Admin123!");
  console.log("Member: member@example.com / Member123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
