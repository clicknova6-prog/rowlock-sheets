import { RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import { COLUMN_KEYS, MAX_ROWS, getCellKey } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import type { CellState, ConditionalRuleState, RuleConditionState } from "./types";

export interface ConditionalRuleEvaluationInput {
  cells: CellState[];
  rules: ConditionalRuleState[];
  maxRows?: number;
}

export interface RuleViolation {
  ruleId: string;
  ruleName: string;
  limitCount: number;
  matchedCount: number;
  message: string;
}

function getComparableValue(cell?: CellState): string {
  return (cell?.computedValue ?? cell?.value ?? "").trim();
}

function normalizeValues(values: string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function buildCellLookup(cells: CellState[]): Map<string, CellState> {
  const lookup = new Map<string, CellState>();

  for (const cell of cells) {
    lookup.set(getCellKey(cell.rowIndex, cell.columnKey), cell);
  }

  return lookup;
}

export function doesConditionMatch(
  condition: RuleConditionState,
  value: string
): boolean {
  const normalizedValue = value.trim();
  const normalizedLower = normalizedValue.toLowerCase();
  const allowedValues = normalizeValues(condition.values);

  switch (condition.operator) {
    case RuleOperator.EMPTY:
      return normalizedValue.length === 0;
    case RuleOperator.NOT_EMPTY:
      return normalizedValue.length > 0;
    case RuleOperator.EQUALS:
      return allowedValues.length > 0 && allowedValues.includes(normalizedLower);
    case RuleOperator.IN_LIST:
      return allowedValues.length > 0 && allowedValues.includes(normalizedLower);
    case RuleOperator.CONTAINS:
      return allowedValues.some((allowedValue) => normalizedLower.includes(allowedValue));
    case RuleOperator.NOT_EQUALS:
      return allowedValues.length > 0 && !allowedValues.includes(normalizedLower);
    case RuleOperator.NOT_IN_LIST:
      return allowedValues.length > 0 && !allowedValues.includes(normalizedLower);
    case RuleOperator.NOT_CONTAINS:
      return (
        allowedValues.length > 0 &&
        allowedValues.every((allowedValue) => !normalizedLower.includes(allowedValue))
      );
    default:
      return false;
  }
}

export function rowMatchesRule(
  rowIndex: number,
  lookup: Map<string, CellState>,
  conditions: RuleConditionState[]
): boolean {
  if (conditions.length === 0) {
    return false;
  }

  let currentAndGroupMatches = true;

  for (const [index, condition] of conditions.entries()) {
    const cell = lookup.get(getCellKey(rowIndex, condition.columnKey));
    const conditionMatches = doesConditionMatch(condition, getComparableValue(cell));
    const joinOperator = index === 0 ? RuleJoinOperator.AND : condition.joinOperator;

    if (joinOperator === RuleJoinOperator.OR) {
      if (currentAndGroupMatches) {
        return true;
      }

      currentAndGroupMatches = conditionMatches;
      continue;
    }

    currentAndGroupMatches = currentAndGroupMatches && conditionMatches;
  }

  return currentAndGroupMatches;
}

export function evaluateConditionalRules(
  input: ConditionalRuleEvaluationInput
): RuleViolation[] {
  const maxRows = input.maxRows ?? MAX_ROWS;
  const lookup = buildCellLookup(input.cells);
  const violations: RuleViolation[] = [];

  for (const rule of input.rules) {
    if (!rule.enabled) {
      continue;
    }

    let matchedCount = 0;

    for (let rowIndex = 1; rowIndex <= maxRows; rowIndex += 1) {
      if (rowMatchesRule(rowIndex, lookup, rule.conditions)) {
        matchedCount += 1;
      }
    }

    if (matchedCount > rule.limitCount) {
      violations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        limitCount: rule.limitCount,
        matchedCount,
        message: `${rule.name} allows ${rule.limitCount} matching row${
          rule.limitCount === 1 ? "" : "s"
        }, but this edit would create ${matchedCount}.`
      });
    }
  }

  return violations;
}

export function emptyCellMatrix(rowCount = MAX_ROWS): CellState[] {
  const cells: CellState[] = [];

  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    for (const columnKey of COLUMN_KEYS) {
      cells.push({ rowIndex, columnKey, value: "" });
    }
  }

  return cells;
}

export function parseRuleValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toRuleOperator(value: string): RuleOperator {
  if (Object.values(RuleOperator).includes(value as RuleOperator)) {
    return value as RuleOperator;
  }

  return RuleOperator.EQUALS;
}

export function toRuleJoinOperator(value: string): RuleJoinOperator {
  if (Object.values(RuleJoinOperator).includes(value as RuleJoinOperator)) {
    return value as RuleJoinOperator;
  }

  return RuleJoinOperator.AND;
}

export function isConditionColumn(value: string): value is ColumnKey {
  return COLUMN_KEYS.includes(value as ColumnKey);
}
