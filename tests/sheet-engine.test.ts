import { describe, expect, it } from "vitest";
import { Role, RuleOperator } from "@/generated/prisma/enums";
import { getCellEditDecision } from "@/lib/sheet/permissions";
import { evaluateConditionalRules } from "@/lib/sheet/rules";
import { recalculateCells, mergeRecalculatedCells } from "@/lib/sheet/formulas";
import { validateAllowedValue } from "@/lib/sheet/validation";
import type { CellState, ConditionalRuleState } from "@/lib/sheet/types";

const permissions = [
  { columnKey: "A" as const, editableByMember: true },
  { columnKey: "B" as const, editableByMember: false }
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
              values: ["Ashar"]
            }
          ]
        }
      ]
    });

    expect(violations).toHaveLength(0);
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
