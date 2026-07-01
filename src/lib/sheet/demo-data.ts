import { Role, RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import { COLUMN_KEYS } from "@/lib/constants";
import { buildRowsFromCells } from "./demo-engine";
import { DEFAULT_SHEET_VIEW_SETTING } from "./formatting";
import { mergeRecalculatedCells, recalculateCells } from "./formulas";
import type { CellState, RowOwnershipState, SheetSnapshot } from "./types";

const demoUser = {
  id: "demo-admin",
  name: "Demo Admin",
  email: "demo@example.com",
  role: Role.ADMIN
};

const ownerUser = {
  id: "other-member",
  name: "Other Member"
};

function demoCells(): CellState[] {
  const cells: CellState[] = [
    { rowIndex: 1, columnKey: "A", value: "Ashar" },
    { rowIndex: 1, columnKey: "B", value: "10" },
    { rowIndex: 1, columnKey: "D", value: "" },
    { rowIndex: 1, columnKey: "F", value: "" },
    { rowIndex: 1, columnKey: "G", value: "", formula: "=SUM(B1:B3)" },
    { rowIndex: 2, columnKey: "A", value: "Mina" },
    { rowIndex: 2, columnKey: "B", value: "20" },
    { rowIndex: 2, columnKey: "D", value: "Working" },
    { rowIndex: 3, columnKey: "A", value: "Jordan" },
    { rowIndex: 3, columnKey: "B", value: "30" },
    { rowIndex: 4, columnKey: "A", value: "Ashar" },
    { rowIndex: 4, columnKey: "B", value: "40" },
    { rowIndex: 4, columnKey: "D", value: "" },
    { rowIndex: 4, columnKey: "F", value: "" },
    { rowIndex: 5, columnKey: "A", value: "Ashar" },
    { rowIndex: 5, columnKey: "D", value: "Closed" },
    { rowIndex: 6, columnKey: "C", value: "Admin-only note" }
  ];

  return mergeRecalculatedCells(cells, recalculateCells(cells));
}

export function createDemoSnapshot(): SheetSnapshot {
  const ownerships: RowOwnershipState[] = [
    {
      rowIndex: 2,
      ownerId: demoUser.id,
      ownerName: demoUser.name,
      updatedAt: new Date().toISOString()
    },
    {
      rowIndex: 4,
      ownerId: ownerUser.id,
      ownerName: ownerUser.name,
      updatedAt: new Date().toISOString()
    }
  ];

  const snapshotBase: Omit<SheetSnapshot, "rows"> = {
    currentUser: demoUser,
    sheet: {
      id: "local-demo-sheet",
      name: "Local Demo Sheet"
    },
    columns: [...COLUMN_KEYS],
    viewSetting: {
      ...DEFAULT_SHEET_VIEW_SETTING,
      alternateRowColors: true,
      columnWidths: {},
      condensedView: false,
      frozenHeaderRowIndex: null
    },
    columnPermissions: COLUMN_KEYS.map((columnKey) => ({
      columnKey,
      editableByMember: ["A", "B", "D", "F", "G", "I", "J"].includes(columnKey),
      claimRowOnEdit: ["A", "B", "D", "F", "G", "I", "J"].includes(columnKey),
      memberWriteOnce: ["D"].includes(columnKey),
      duplicateHighlight: ["A"].includes(columnKey),
      matchHighlightTerms: []
    })),
    validationRules: [
      {
        id: "demo-validation-a",
        columnKey: "A",
        name: "Approved names",
        allowedValues: ["Ashar", "Mina", "Jordan"],
        enabled: true
      }
    ],
    conditionalRules: [
      {
        id: "demo-rule-ashar",
        name: "Ashar open case cap",
        description: "A contains Ashar while D and F are empty can happen only 3 times.",
        limitCount: 3,
        enabled: true,
        conditions: [
          {
            columnKey: "A",
            operator: RuleOperator.CONTAINS,
            joinOperator: RuleJoinOperator.AND,
            values: ["Ashar"]
          },
          {
            columnKey: "D",
            operator: RuleOperator.EMPTY,
            joinOperator: RuleJoinOperator.AND,
            values: []
          },
          {
            columnKey: "F",
            operator: RuleOperator.EMPTY,
            joinOperator: RuleJoinOperator.AND,
            values: []
          }
        ]
      }
    ],
    auditLogs: [
      {
        id: "demo-audit-1",
        action: "LOCAL_DEMO",
        actorName: "System",
        rowIndex: null,
        columnKey: null,
        message: "Running without SQL or authentication. Changes stay in browser memory.",
        createdAt: new Date().toISOString()
      }
    ]
  };

  return {
    ...snapshotBase,
    rows: buildRowsFromCells(snapshotBase, demoCells(), ownerships)
  };
}
