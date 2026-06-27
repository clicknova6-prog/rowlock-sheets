"use server";

import { revalidatePath } from "next/cache";
import { AuditAction, RuleOperator } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/auth/session";
import { COLUMN_KEYS, assertColumnKey, isValidRowIndex } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { unlockRow } from "@/lib/sheet/service";
import { normalizeHexColor } from "@/lib/sheet/formatting";
import { parseRuleValues, toRuleOperator } from "@/lib/sheet/rules";
import { parseAllowedValues } from "@/lib/sheet/validation";

function getString(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

async function auditAdminChange(
  sheetId: string,
  actorId: string,
  action: AuditAction,
  message: string
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      sheetId,
      actorId,
      action,
      message
    }
  });
}

function refreshApp(): void {
  revalidatePath("/");
  revalidatePath("/admin");
}

export async function saveColumnPermissionsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const permissions = COLUMN_KEYS.map((columnKey) => ({
    sheetId,
    columnKey,
    editableByMember: formData.has(`permission-${columnKey}`)
  }));

  await prisma.$transaction(
    async (tx) => {
      await tx.columnPermission.deleteMany({ where: { sheetId } });
      await tx.columnPermission.createMany({ data: permissions });
      await tx.auditLog.create({
        data: {
          sheetId,
          actorId: actor.id,
          action: AuditAction.COLUMN_PERMISSION_UPDATED,
          message: `${actor.name} updated column permissions.`
        }
      });
    },
    {
      maxWait: 10000,
      timeout: 20000
    }
  );

  refreshApp();
}

export async function saveSheetViewSettingsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const alternateRowColors = formData.has("alternateRowColors");
  const alternateOddColor = normalizeHexColor(getString(formData, "alternateOddColor")) ?? "#ffffff";
  const alternateEvenColor = normalizeHexColor(getString(formData, "alternateEvenColor")) ?? "#f8fafc";

  await prisma.$transaction(async (tx) => {
    await tx.sheetViewSetting.upsert({
      where: { sheetId },
      create: {
        sheetId,
        alternateRowColors,
        alternateOddColor,
        alternateEvenColor
      },
      update: {
        alternateRowColors,
        alternateOddColor,
        alternateEvenColor
      }
    });

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.SHEET_VIEW_UPDATED,
        message: `${actor.name} updated sheet view settings.`
      }
    });
  });

  refreshApp();
}

export async function saveValidationRuleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const id = getString(formData, "id");
  const columnKey = assertColumnKey(getString(formData, "columnKey"));
  const name = getString(formData, "name") || `Allowed values for ${columnKey}`;
  const allowedValues = parseAllowedValues(getString(formData, "allowedValues"));
  const enabled = formData.has("enabled");

  if (allowedValues.length === 0) {
    return;
  }

  if (id) {
    await prisma.validationRule.update({
      where: { id },
      data: { columnKey, name, allowedValues, enabled }
    });
  } else {
    await prisma.validationRule.create({
      data: { sheetId, columnKey, name, allowedValues, enabled }
    });
  }

  await auditAdminChange(
    sheetId,
    actor.id,
    AuditAction.VALIDATION_RULE_UPDATED,
    `${actor.name} saved validation rule "${name}".`
  );

  refreshApp();
}

export async function deleteValidationRuleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const id = getString(formData, "id");

  if (!id) {
    return;
  }

  await prisma.validationRule.delete({ where: { id } });
  await auditAdminChange(
    sheetId,
    actor.id,
    AuditAction.VALIDATION_RULE_UPDATED,
    `${actor.name} deleted a validation rule.`
  );

  refreshApp();
}

export async function saveConditionalRuleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const id = getString(formData, "id");
  const name = getString(formData, "name") || "Untitled rule";
  const description = getString(formData, "description") || null;
  const limitCount = Math.max(1, Number.parseInt(getString(formData, "limitCount"), 10) || 1);
  const enabled = formData.has("enabled");

  const columns = formData.getAll("conditionColumn").map((value) => String(value));
  const operators = formData.getAll("conditionOperator").map((value) => String(value));
  const values = formData.getAll("conditionValues").map((value) => String(value));

  const conditions = columns
    .map((column, index) => {
      if (!column) {
        return null;
      }

      const operator = toRuleOperator(operators[index] ?? RuleOperator.EQUALS);
      return {
        columnKey: assertColumnKey(column),
        operator,
        values:
          operator === RuleOperator.EMPTY || operator === RuleOperator.NOT_EMPTY
            ? []
            : parseRuleValues(values[index] ?? "")
      };
    })
    .filter(Boolean);

  if (conditions.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (id) {
      await tx.conditionalRule.update({
        where: { id },
        data: { name, description, limitCount, enabled }
      });
      await tx.ruleCondition.deleteMany({ where: { ruleId: id } });
      await tx.ruleCondition.createMany({
        data: conditions.map((condition) => ({
          ruleId: id,
          columnKey: condition!.columnKey,
          operator: condition!.operator,
          values: condition!.values
        }))
      });
    } else {
      await tx.conditionalRule.create({
        data: {
          sheetId,
          name,
          description,
          limitCount,
          enabled,
          conditions: {
            create: conditions.map((condition) => ({
              columnKey: condition!.columnKey,
              operator: condition!.operator,
              values: condition!.values
            }))
          }
        }
      });
    }

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.CONDITIONAL_RULE_UPDATED,
        message: `${actor.name} saved conditional rule "${name}".`
      }
    });
  });

  refreshApp();
}

export async function deleteConditionalRuleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const id = getString(formData, "id");

  if (!id) {
    return;
  }

  await prisma.conditionalRule.delete({ where: { id } });
  await auditAdminChange(
    sheetId,
    actor.id,
    AuditAction.CONDITIONAL_RULE_UPDATED,
    `${actor.name} deleted a conditional rule.`
  );

  refreshApp();
}

export async function unlockRowAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const rowIndex = Number.parseInt(getString(formData, "rowIndex"), 10);

  if (!isValidRowIndex(rowIndex)) {
    return;
  }

  await unlockRow(actor, sheetId, rowIndex);
  refreshApp();
}
