import { Role } from "@/generated/prisma/enums";
import type { ColumnKey } from "@/lib/constants";
import type { AppRole, ValidationRuleState } from "./types";

export interface AllowedValueValidationInput {
  role: AppRole;
  columnKey: ColumnKey;
  nextValue: string;
  validationRules: ValidationRuleState[];
}

export interface ValidationDecision {
  valid: boolean;
  reason: string | null;
}

export function normalizeAllowedValues(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseAllowedValues(value: string): string[] {
  return normalizeAllowedValues(value.split(/[\n,]/));
}

export function validateAllowedValue(input: AllowedValueValidationInput): ValidationDecision {
  if (input.role === Role.ADMIN) {
    return { valid: true, reason: null };
  }

  const activeRules = input.validationRules.filter(
    (rule) => rule.enabled && rule.columnKey === input.columnKey
  );

  if (activeRules.length === 0) {
    return { valid: true, reason: null };
  }

  const nextValue = input.nextValue.trim().toLowerCase();

  if (nextValue === "") {
    return { valid: true, reason: null };
  }

  for (const rule of activeRules) {
    const allowed = normalizeAllowedValues(rule.allowedValues).map((value) =>
      value.toLowerCase()
    );

    if (!allowed.includes(nextValue)) {
      return {
        valid: false,
        reason: `${rule.name} only allows: ${rule.allowedValues.join(", ")}.`
      };
    }
  }

  return { valid: true, reason: null };
}
