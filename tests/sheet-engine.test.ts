import { describe, expect, it } from "vitest";
import { Role, RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import { COLUMN_KEYS } from "@/lib/constants";
import { buildRowsFromCells } from "@/lib/sheet/demo-engine";
import { getCellEditDecision } from "@/lib/sheet/permissions";
import { parseRowIndexList } from "@/lib/sheet/row-index-list";
import { getRowsForPersistedCellUpdates } from "@/lib/sheet/row-payloads";
import { evaluateConditionalRules } from "@/lib/sheet/rules";
import { recalculateCells, mergeRecalculatedCells } from "@/lib/sheet/formulas";
import { validateAllowedValue } from "@/lib/sheet/validation";
import type {
  CellState,
  ColumnPermissionState,
  ConditionalRuleState,
  SheetGridRow,
  SheetSnapshot
} from "@/lib/sheet/types";

const permissions: ColumnPermissionState[] = [
  {
    columnKey: "A",
    editableByMember: true,
    claimRowOnEdit: true,
    memberWriteOnce: false,
    memberEditDelaySourceColumnKey: null,
    memberEditDelayMinutes: 0,
    duplicateHighlight: false,
    matchHighlightTerms: []
  },
  {
    columnKey: "B",
    editableByMember: false,
    claimRowOnEdit: false,
    memberWriteOnce: false,
    memberEditDelaySourceColumnKey: null,
    memberEditDelayMinutes: 0,
    duplicateHighlight: false,
    matchHighlightTerms: []
  },
  {
    columnKey: "C",
    editableByMember: true,
    claimRowOnEdit: false,
    memberWriteOnce: true,
    memberEditDelaySourceColumnKey: null,
    memberEditDelayMinutes: 0,
    duplicateHighlight: false,
    matchHighlightTerms: []
  }
];

describe("cell permission and row ownership rules", () => {
  it("lets admins edit admin-only columns", () => {
    const decision = getCellEditDecision({
      role: Role.ADMIN,
      userId: "admin",
      columnKey: "B",
      columnPermissions: permissions
    });

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("admin");
  });

  it("blocks members from admin-only columns", () => {
    const decision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "B",
      columnPermissions: permissions
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("admin-only");
  });

  it("claims an unowned row on the first valid member edit", () => {
    const decision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "A",
      columnPermissions: permissions
    });

    expect(decision.allowed).toBe(true);
    expect(decision.willClaimRow).toBe(true);
  });

  it("allows member edits without claiming when the column is not a claim column", () => {
    const decision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "C",
      columnPermissions: permissions
    });

    expect(decision.allowed).toBe(true);
    expect(decision.willClaimRow).toBe(false);
  });

  it("blocks members from rows owned by another member", () => {
    const decision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member-2",
      columnKey: "A",
      columnPermissions: permissions,
      ownership: {
        rowIndex: 8,
        ownerId: "member-1",
        ownerName: "Member One"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.state).toBe("owned-by-other");
  });

  it("blocks members from changing write-once cells after first entry", () => {
    const decision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "C",
      columnPermissions: permissions,
      currentValue: "Already filled"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("first entry");
  });

  it("blocks delayed member columns until the source cell is old enough", () => {
    const delayedPermissions: ColumnPermissionState[] = permissions.map((permission) =>
      permission.columnKey === "C"
        ? {
            ...permission,
            memberWriteOnce: false,
            memberEditDelaySourceColumnKey: "A",
            memberEditDelayMinutes: 20
          }
        : permission
    );
    const sourceUpdatedAt = new Date("2026-07-03T10:00:00.000Z");
    const tooSoonDecision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "C",
      columnPermissions: delayedPermissions,
      delaySourceCell: {
        value: "Ashar",
        updatedAt: sourceUpdatedAt
      },
      now: new Date("2026-07-03T10:10:00.000Z")
    });
    const openDecision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "C",
      columnPermissions: delayedPermissions,
      delaySourceCell: {
        value: "Ashar",
        updatedAt: sourceUpdatedAt
      },
      now: new Date("2026-07-03T10:21:00.000Z")
    });

    expect(tooSoonDecision.allowed).toBe(false);
    expect(tooSoonDecision.reason).toContain("opens in");
    expect(openDecision.allowed).toBe(true);
  });

  it("blocks members after the sheet-wide member edit lock time", () => {
    const lockedMemberDecision = getCellEditDecision({
      role: Role.MEMBER,
      userId: "member",
      columnKey: "A",
      columnPermissions: permissions,
      memberEditLockAt: "2026-07-03T10:00:00.000Z",
      now: new Date("2026-07-03T10:01:00.000Z")
    });
    const adminDecision = getCellEditDecision({
      role: Role.ADMIN,
      userId: "admin",
      columnKey: "A",
      columnPermissions: permissions,
      memberEditLockAt: "2026-07-03T10:00:00.000Z",
      now: new Date("2026-07-03T10:01:00.000Z")
    });

    expect(lockedMemberDecision.allowed).toBe(false);
    expect(lockedMemberDecision.reason).toContain("locked");
    expect(adminDecision.allowed).toBe(true);
  });
});

describe("row number list parsing", () => {
  it("parses comma, whitespace, and range row lists", () => {
    const result = parseRowIndexList("4, 8 - 10\n20", 20);

    expect(result.rowIndexes).toEqual([4, 8, 9, 10, 20]);
    expect(result.invalidTokens).toEqual([]);
  });
});

describe("allowed-value validation", () => {
  it("accepts configured allowed values for members", () => {
    const result = validateAllowedValue({
      role: Role.MEMBER,
      columnKey: "A",
      nextValue: "ashar",
      validationRules: [
        {
          columnKey: "A",
          name: "Approved names",
          allowedValues: ["Ashar", "Mina"],
          enabled: true
        }
      ]
    });

    expect(result.valid).toBe(true);
  });

  it("rejects values outside the allowed list for members", () => {
    const result = validateAllowedValue({
      role: Role.MEMBER,
      columnKey: "A",
      nextValue: "Unknown",
      validationRules: [
        {
          columnKey: "A",
          name: "Approved names",
          allowedValues: ["Ashar", "Mina"],
          enabled: true
        }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Ashar");
  });

  it("lets admins bypass allowed-value validation", () => {
    const result = validateAllowedValue({
      role: Role.ADMIN,
      columnKey: "A",
      nextValue: "Unknown",
      validationRules: [
        {
          columnKey: "A",
          name: "Approved names",
          allowedValues: ["Ashar"],
          enabled: true
        }
      ]
    });

    expect(result.valid).toBe(true);
  });
});

describe("conditional rule engine", () => {
  it("rejects edits that exceed a multi-column count rule", () => {
    const cells: CellState[] = [
      { rowIndex: 1, columnKey: "A", value: "Ashar" },
      { rowIndex: 1, columnKey: "D", value: "" },
      { rowIndex: 1, columnKey: "F", value: "" },
      { rowIndex: 2, columnKey: "A", value: "Ashar" },
      { rowIndex: 2, columnKey: "D", value: "" },
      { rowIndex: 2, columnKey: "F", value: "" },
      { rowIndex: 3, columnKey: "A", value: "Ashar" },
      { rowIndex: 3, columnKey: "D", value: "" },
      { rowIndex: 3, columnKey: "F", value: "" }
    ];

    const rules: ConditionalRuleState[] = [
      {
        id: "rule-1",
        name: "Ashar open case cap",
        limitCount: 2,
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
    ];

    const violations = evaluateConditionalRules({ cells, rules, maxRows: 5 });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("2");
  });

  it("ignores disabled conditional rules", () => {
    const violations = evaluateConditionalRules({
      cells: [{ rowIndex: 1, columnKey: "A", value: "Ashar" }],
      maxRows: 1,
      rules: [
        {
          id: "rule-1",
          name: "Disabled rule",
          limitCount: 0,
          enabled: false,
          conditions: [
            {
              columnKey: "A",
              operator: RuleOperator.CONTAINS,
              joinOperator: RuleJoinOperator.AND,
              values: ["Ashar"]
            }
          ]
        }
      ]
    });

    expect(violations).toHaveLength(0);
  });

  it("supports OR groups and negative conditional operators", () => {
    const cells: CellState[] = [
      { rowIndex: 1, columnKey: "A", value: "Ashar" },
      { rowIndex: 1, columnKey: "B", value: "working" },
      { rowIndex: 1, columnKey: "C", value: "fresh lead" },
      { rowIndex: 1, columnKey: "D", value: "" },
      { rowIndex: 1, columnKey: "E", value: "" },
      { rowIndex: 2, columnKey: "A", value: "Ashar" },
      { rowIndex: 2, columnKey: "B", value: "NEC" },
      { rowIndex: 2, columnKey: "C", value: "fresh lead" },
      { rowIndex: 2, columnKey: "D", value: "" },
      { rowIndex: 2, columnKey: "E", value: "" },
      { rowIndex: 3, columnKey: "A", value: "Mina" },
      { rowIndex: 3, columnKey: "B", value: "working" },
      { rowIndex: 3, columnKey: "C", value: "OON" },
      { rowIndex: 3, columnKey: "D", value: "" },
      { rowIndex: 3, columnKey: "E", value: "" }
    ];

    const rules: ConditionalRuleState[] = [
      {
        id: "rule-logic",
        name: "Ashar open usable rows",
        limitCount: 0,
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
            columnKey: "E",
            operator: RuleOperator.EMPTY,
            joinOperator: RuleJoinOperator.AND,
            values: []
          },
          {
            columnKey: "B",
            operator: RuleOperator.NOT_IN_LIST,
            joinOperator: RuleJoinOperator.AND,
            values: ["NEC", "not enough candidates"]
          },
          {
            columnKey: "C",
            operator: RuleOperator.NOT_CONTAINS,
            joinOperator: RuleJoinOperator.AND,
            values: ["OON"]
          }
        ]
      },
      {
        id: "rule-or",
        name: "Ashar or OON",
        limitCount: 1,
        enabled: true,
        conditions: [
          {
            columnKey: "A",
            operator: RuleOperator.CONTAINS,
            joinOperator: RuleJoinOperator.AND,
            values: ["Ashar"]
          },
          {
            columnKey: "C",
            operator: RuleOperator.CONTAINS,
            joinOperator: RuleJoinOperator.OR,
            values: ["OON"]
          }
        ]
      }
    ];

    const violations = evaluateConditionalRules({ cells, rules, maxRows: 3 });

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      "rule-logic",
      "rule-or"
    ]);
  });
});

describe("formula recalculation", () => {
  it("calculates SUM and arithmetic formulas", () => {
    const cells: CellState[] = [
      { rowIndex: 1, columnKey: "B", value: "10" },
      { rowIndex: 2, columnKey: "B", value: "20" },
      { rowIndex: 3, columnKey: "B", value: "30" },
      { rowIndex: 1, columnKey: "G", value: "", formula: "=SUM(B1:B3)" },
      { rowIndex: 1, columnKey: "H", value: "", formula: "=B1+B2*2" }
    ];

    const merged = mergeRecalculatedCells(cells, recalculateCells(cells, 5));
    const sumCell = merged.find((cell) => cell.rowIndex === 1 && cell.columnKey === "G");
    const arithmeticCell = merged.find(
      (cell) => cell.rowIndex === 1 && cell.columnKey === "H"
    );

    expect(sumCell?.computedValue).toBe("60");
    expect(arithmeticCell?.computedValue).toBe("50");
  });
});

describe("sheet row building", () => {
  it("uses the raw value when persisted formula is an empty string", () => {
    const rows = buildRowsFromCells(
      {
        currentUser: {
          id: "admin",
          name: "Admin",
          email: "admin@example.com",
          role: Role.ADMIN
        },
        sheet: {
          id: "sheet-1",
          name: "Operations Tracker"
        },
        columns: [...COLUMN_KEYS],
        viewSetting: {
          alternateRowColors: false,
          alternateOddColor: "#ffffff",
          alternateEvenColor: "#f8fafc",
          fontSize: 14,
          columnWidths: {},
          condensedView: false,
          frozenHeaderRowIndex: null,
          memberEditLockAt: null
        },
        columnPermissions: [],
        validationRules: [],
        conditionalRules: [],
        auditLogs: []
      },
      [
        {
          rowIndex: 5,
          columnKey: "C",
          value: "gdhdh",
          formula: "",
          computedValue: ""
        }
      ],
      []
    );

    expect(rows[4].C).toBe("gdhdh");
    expect(rows[4].__computed.C).toBe("gdhdh");
    expect(rows[4].__formula.C).toBe(false);
  });
});

describe("persisted row payloads", () => {
  function makePayloadRow(rowNumber: number, formulaColumns: string[] = []): SheetGridRow {
    return {
      rowNumber,
      __formula: {
        A: formulaColumns.includes("A"),
        B: formulaColumns.includes("B")
      }
    } as SheetGridRow;
  }

  function makePayloadSnapshot(
    rows: SheetGridRow[],
    duplicateHighlight = false
  ): SheetSnapshot {
    return {
      columns: ["A", "B"],
      rows,
      columnPermissions: [
        {
          columnKey: "A",
          editableByMember: true,
          claimRowOnEdit: false,
          memberWriteOnce: false,
          duplicateHighlight,
          matchHighlightTerms: []
        },
        {
          columnKey: "B",
          editableByMember: true,
          claimRowOnEdit: false,
          memberWriteOnce: false,
          duplicateHighlight: false,
          matchHighlightTerms: []
        }
      ]
    } as unknown as SheetSnapshot;
  }

  it("sends only touched rows for ordinary persisted edits", () => {
    const snapshot = makePayloadSnapshot([
      makePayloadRow(1),
      makePayloadRow(2),
      makePayloadRow(3)
    ]);

    const rows = getRowsForPersistedCellUpdates(snapshot, [{ rowIndex: 2, columnKey: "A" }]);

    expect(rows.map((row) => row.rowNumber)).toEqual([2]);
  });

  it("includes formula rows because their computed values may change", () => {
    const snapshot = makePayloadSnapshot([
      makePayloadRow(1),
      makePayloadRow(2, ["B"]),
      makePayloadRow(3)
    ]);

    const rows = getRowsForPersistedCellUpdates(snapshot, [{ rowIndex: 1, columnKey: "A" }]);

    expect(rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it("sends the full sheet when duplicate highlighting may change other rows", () => {
    const snapshot = makePayloadSnapshot(
      [makePayloadRow(1), makePayloadRow(2), makePayloadRow(3)],
      true
    );

    const rows = getRowsForPersistedCellUpdates(snapshot, [{ rowIndex: 1, columnKey: "A" }]);

    expect(rows).toHaveLength(3);
  });
});
