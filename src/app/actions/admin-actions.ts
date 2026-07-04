"use server";

import { revalidatePath } from "next/cache";
import { AuditAction, RuleJoinOperator, RuleOperator } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/auth/session";
import { COLUMN_KEYS, assertColumnKey, isValidRowIndex } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  createFirebaseMember,
  deleteFirebaseMember,
  updateFirebaseMemberPassword
} from "@/lib/firebase/users";
import {
  mirrorSheetConfigToRealtimeDatabase,
  mirrorSheetRowsToRealtimeDatabase
} from "@/lib/firebase/realtime-sheet-mirror";
import { publishSheetRealtimeEvent } from "@/lib/firebase/sheet-realtime";
import { parseRowIndexList } from "@/lib/sheet/row-index-list";
import { resetRows, unlockRow, unlockRows } from "@/lib/sheet/service";
import { getSheetSnapshot } from "@/lib/sheet/snapshot";
import {
  DEFAULT_SHEET_VIEW_SETTING,
  normalizeHexColor,
  normalizeSheetCondensedView,
  normalizeSheetFontSize,
  normalizeSheetFrozenHeaderRowIndex
} from "@/lib/sheet/formatting";
import { parseRuleValues, toRuleJoinOperator, toRuleOperator } from "@/lib/sheet/rules";
import { parseAllowedValues } from "@/lib/sheet/validation";
import type { Actor } from "@/lib/sheet/types";

export interface CreateMemberActionState {
  ok: boolean;
  message: string;
}

export interface MemberManagementActionState {
  ok: boolean;
  message: string;
  memberId?: string;
}

const CREATE_MEMBER_INITIAL_STATE: CreateMemberActionState = {
  ok: false,
  message: ""
};

function getString(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseMatchHighlightTerms(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return [...new Set(parsed.map((term) => String(term).trim()).filter(Boolean))].slice(0, 500);
  } catch {
    return [];
  }
}

function parseDelayMinutes(value: string): number {
  const minutes = Number.parseInt(value, 10);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }

  return Math.min(1440, minutes);
}

function parseLockDelayMinutes(value: string): number | null {
  const minutes = Number.parseInt(value, 10);

  if (!Number.isInteger(minutes) || minutes <= 0) {
    return null;
  }

  return Math.min(7 * 24 * 60, minutes);
}

function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }

  if (password.length > 128) {
    return "Password is too long.";
  }

  return null;
}

function uniqueTrimmedValues(values: string[]): string[] {
  const valueLookup = new Map<string, string>();

  for (const value of values) {
    const trimmed = value.trim();

    if (trimmed) {
      valueLookup.set(trimmed.toLowerCase(), trimmed);
    }
  }

  return [...valueLookup.values()];
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

async function publishSheetSettingsRefresh(sheetId: string, actor: Actor): Promise<void> {
  const snapshot = await getSheetSnapshot(sheetId, actor);

  await mirrorSheetConfigToRealtimeDatabase(snapshot);
  await publishSheetRealtimeEvent({
    type: "format-changed",
    sheetId,
    actor,
    snapshot,
    requiresRefresh: true
  });
}

export async function createMemberAction(
  previousState: CreateMemberActionState = CREATE_MEMBER_INITIAL_STATE,
  formData: FormData
): Promise<CreateMemberActionState> {
  void previousState;
  await requireAdmin();

  const email = getString(formData, "email").toLowerCase();
  const name = getString(formData, "name");
  const password = getString(formData, "password");

  if (!isValidEmail(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return { ok: false, message: passwordError };
  }

  if (name.length > 120) {
    return { ok: false, message: "Name must be 120 characters or fewer." };
  }

  try {
    const member = await createFirebaseMember({
      email,
      name: name || email.split("@")[0] || "Member",
      password
    });

    refreshApp();

    return {
      ok: true,
      message: `${member.email} can now log in as a member.`
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to create this member.";

    return {
      ok: false,
      message
    };
  }
}

export async function changeMemberPasswordAction(
  previousState: MemberManagementActionState,
  formData: FormData
): Promise<MemberManagementActionState> {
  void previousState;
  await requireAdmin();

  const memberId = getString(formData, "memberId");
  const password = getString(formData, "password");
  const passwordError = validatePassword(password);

  if (!memberId) {
    return { ok: false, message: "Choose a member first." };
  }

  if (passwordError) {
    return { ok: false, message: passwordError, memberId };
  }

  try {
    const member = await updateFirebaseMemberPassword(memberId, password);
    refreshApp();

    return {
      ok: true,
      memberId,
      message: `Password changed for ${member.email}.`
    };
  } catch (error) {
    return {
      ok: false,
      memberId,
      message: error instanceof Error ? error.message : "Unable to change this password."
    };
  }
}

export async function deleteMemberAction(
  previousState: MemberManagementActionState,
  formData: FormData
): Promise<MemberManagementActionState> {
  void previousState;
  const actor = await requireAdmin();
  const memberId = getString(formData, "memberId");

  if (!memberId) {
    return { ok: false, message: "Choose a member first." };
  }

  if (memberId === actor.id) {
    return {
      ok: false,
      memberId,
      message: "You cannot delete your own admin account here."
    };
  }

  try {
    const member = await deleteFirebaseMember(memberId);
    refreshApp();

    return {
      ok: true,
      memberId,
      message: `${member.email} was deleted.`
    };
  } catch (error) {
    return {
      ok: false,
      memberId,
      message: error instanceof Error ? error.message : "Unable to delete this member."
    };
  }
}

export async function saveColumnPermissionsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const permissions = COLUMN_KEYS.map((columnKey) => {
    const editableByMember = formData.has(`permission-${columnKey}`);
    const delayMinutes = parseDelayMinutes(getString(formData, `delayMinutes-${columnKey}`));
    const rawDelaySourceColumnKey = getString(formData, `delaySource-${columnKey}`);
    const memberEditDelaySourceColumnKey =
      editableByMember &&
      delayMinutes > 0 &&
      rawDelaySourceColumnKey &&
      rawDelaySourceColumnKey !== columnKey
        ? assertColumnKey(rawDelaySourceColumnKey)
        : null;

    return {
      sheetId,
      columnKey,
      editableByMember,
      claimRowOnEdit: editableByMember && formData.has(`claimRow-${columnKey}`),
      memberWriteOnce: formData.has(`writeOnce-${columnKey}`),
      memberEditDelaySourceColumnKey,
      memberEditDelayMinutes: memberEditDelaySourceColumnKey ? delayMinutes : 0,
      duplicateHighlight: formData.has(`duplicateHighlight-${columnKey}`),
      matchHighlightTerms: parseMatchHighlightTerms(
        getString(formData, `matchHighlightTerms-${columnKey}`)
      )
    };
  });

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

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function saveSheetViewSettingsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const alternateRowColors = formData.has("alternateRowColors");
  const alternateOddColor = normalizeHexColor(getString(formData, "alternateOddColor")) ?? "#ffffff";
  const alternateEvenColor = normalizeHexColor(getString(formData, "alternateEvenColor")) ?? "#f8fafc";
  const fontSize = normalizeSheetFontSize(getString(formData, "fontSize"));
  const condensedView = normalizeSheetCondensedView(formData.get("condensedView"));
  const frozenHeaderRowIndex = normalizeSheetFrozenHeaderRowIndex(
    getString(formData, "frozenHeaderRowIndex")
  );

  await prisma.$transaction(async (tx) => {
    await tx.sheetViewSetting.upsert({
      where: { sheetId },
      create: {
        sheetId,
        alternateRowColors,
        alternateOddColor,
        alternateEvenColor,
        fontSize,
        condensedView,
        frozenHeaderRowIndex
      },
      update: {
        alternateRowColors,
        alternateOddColor,
        alternateEvenColor,
        fontSize,
        condensedView,
        frozenHeaderRowIndex
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

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function saveValidationRuleAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const id = getString(formData, "id");
  const columnKey = assertColumnKey(getString(formData, "columnKey"));
  const name = getString(formData, "name") || `Allowed values for ${columnKey}`;
  const allowedValues = uniqueTrimmedValues(parseAllowedValues(getString(formData, "allowedValues")));
  const enabled = formData.has("enabled");

  if (allowedValues.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (id) {
      await tx.validationRule.update({
        where: { id },
        data: { columnKey, name, allowedValues, enabled }
      });
    } else {
      await tx.validationRule.create({
        data: { sheetId, columnKey, name, allowedValues, enabled }
      });
    }

    const existingRules = await tx.conditionalRule.findMany({
      where: { sheetId },
      include: { conditions: true }
    });
    const existingSingleValueLimits = new Set<string>();

    for (const rule of existingRules) {
      for (const condition of rule.conditions) {
        if (condition.columnKey !== columnKey || !Array.isArray(condition.values)) {
          continue;
        }

        const conditionValues = uniqueTrimmedValues(
          condition.values.map((value) => String(value))
        );

        if (conditionValues.length === 1) {
          existingSingleValueLimits.add(conditionValues[0].toLowerCase());
        }
      }
    }

    const missingValues = allowedValues.filter(
      (value) => !existingSingleValueLimits.has(value.toLowerCase())
    );

    for (const value of missingValues) {
      await tx.conditionalRule.create({
        data: {
          sheetId,
          name: `${columnKey}: ${value}`,
          description: `Default one-match limit for ${value}.`,
          limitCount: 1,
          enabled,
          conditions: {
            create: [
              {
                columnKey,
                operator: RuleOperator.EQUALS,
                values: [value]
              }
            ]
          }
        }
      });
    }

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.VALIDATION_RULE_UPDATED,
        message: `${actor.name} saved validation rule "${name}"${
          missingValues.length > 0
            ? ` and created ${missingValues.length} default count rule${
                missingValues.length === 1 ? "" : "s"
              }.`
            : "."
        }`
      }
    });
  });

  await publishSheetSettingsRefresh(sheetId, actor);
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

  await publishSheetSettingsRefresh(sheetId, actor);
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
  const joinOperators = formData.getAll("conditionJoinOperator").map((value) => String(value));
  const values = formData.getAll("conditionValues").map((value) => String(value));

  const conditions = columns
    .map((column, index) => {
      if (!column) {
        return null;
      }

      const operator = toRuleOperator(operators[index] ?? RuleOperator.EQUALS);
      const joinOperator =
        index === 0
          ? RuleJoinOperator.AND
          : toRuleJoinOperator(joinOperators[index] ?? RuleJoinOperator.AND);

      return {
        columnKey: assertColumnKey(column),
        operator,
        joinOperator,
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
          joinOperator: condition!.joinOperator,
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
              joinOperator: condition!.joinOperator,
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

  await publishSheetSettingsRefresh(sheetId, actor);
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

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function unlockRowAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const rowIndex = Number.parseInt(getString(formData, "rowIndex"), 10);

  if (!isValidRowIndex(rowIndex)) {
    return;
  }

  const snapshot = await unlockRow(actor, sheetId, rowIndex);
  await mirrorSheetRowsToRealtimeDatabase(
    snapshot,
    snapshot.rows.filter((row) => row.rowNumber === rowIndex)
  );
  refreshApp();
}

export async function deleteOldAuditHistoryAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await prisma.auditLog.deleteMany({
    where: {
      sheetId,
      createdAt: { lt: cutoff }
    }
  });

  await prisma.auditLog.create({
    data: {
      sheetId,
      actorId: actor.id,
      action: AuditAction.AUDIT_HISTORY_CLEANED,
      message: `${actor.name} deleted ${result.count} audit entr${
        result.count === 1 ? "y" : "ies"
      } older than 1 day.`
    }
  });

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function deleteAllAuditHistoryAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");

  await prisma.auditLog.deleteMany({
    where: { sheetId }
  });

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function scheduleMemberSheetLockAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const delayMinutes = parseLockDelayMinutes(getString(formData, "lockDelayMinutes"));

  if (!delayMinutes) {
    return;
  }

  const memberEditLockAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.sheetViewSetting.upsert({
      where: { sheetId },
      create: {
        sheetId,
        alternateRowColors: DEFAULT_SHEET_VIEW_SETTING.alternateRowColors,
        alternateOddColor: DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
        alternateEvenColor: DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
        fontSize: DEFAULT_SHEET_VIEW_SETTING.fontSize,
        columnWidths: DEFAULT_SHEET_VIEW_SETTING.columnWidths,
        condensedView: DEFAULT_SHEET_VIEW_SETTING.condensedView,
        frozenHeaderRowIndex: DEFAULT_SHEET_VIEW_SETTING.frozenHeaderRowIndex,
        memberEditLockAt
      },
      update: { memberEditLockAt }
    });

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.SHEET_VIEW_UPDATED,
        message: `${actor.name} scheduled member editing to lock at ${memberEditLockAt.toLocaleString()}.`,
        metadata: {
          memberEditLockAt: memberEditLockAt.toISOString(),
          delayMinutes
        }
      }
    });
  });

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function unlockMemberSheetEditingAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");

  await prisma.$transaction(async (tx) => {
    await tx.sheetViewSetting.upsert({
      where: { sheetId },
      create: {
        sheetId,
        alternateRowColors: DEFAULT_SHEET_VIEW_SETTING.alternateRowColors,
        alternateOddColor: DEFAULT_SHEET_VIEW_SETTING.alternateOddColor,
        alternateEvenColor: DEFAULT_SHEET_VIEW_SETTING.alternateEvenColor,
        fontSize: DEFAULT_SHEET_VIEW_SETTING.fontSize,
        columnWidths: DEFAULT_SHEET_VIEW_SETTING.columnWidths,
        condensedView: DEFAULT_SHEET_VIEW_SETTING.condensedView,
        frozenHeaderRowIndex: DEFAULT_SHEET_VIEW_SETTING.frozenHeaderRowIndex,
        memberEditLockAt: null
      },
      update: { memberEditLockAt: null }
    });

    await tx.auditLog.create({
      data: {
        sheetId,
        actorId: actor.id,
        action: AuditAction.SHEET_VIEW_UPDATED,
        message: `${actor.name} made the sheet editable for members.`
      }
    });
  });

  await publishSheetSettingsRefresh(sheetId, actor);
  refreshApp();
}

export async function unlockRowsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const { rowIndexes } = parseRowIndexList(getString(formData, "rowNumbers"), 500);

  if (rowIndexes.length === 0) {
    return;
  }

  const snapshot = await unlockRows(actor, sheetId, rowIndexes);
  await mirrorSheetRowsToRealtimeDatabase(
    snapshot,
    snapshot.rows.filter((row) => rowIndexes.includes(row.rowNumber))
  );
  refreshApp();
}

export async function resetRowsAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const sheetId = getString(formData, "sheetId");
  const { rowIndexes } = parseRowIndexList(getString(formData, "rowNumbers"), 500);

  if (rowIndexes.length === 0) {
    return;
  }

  const snapshot = await resetRows(actor, sheetId, rowIndexes);
  await mirrorSheetRowsToRealtimeDatabase(
    snapshot,
    snapshot.rows.filter((row) => rowIndexes.includes(row.rowNumber))
  );
  refreshApp();
}
