import { COLUMN_KEYS, MAX_ROWS } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import type {
  CellFormatPatch,
  CellFormatState,
  HorizontalAlign,
  SheetViewSettingState
} from "./types";

export const FORMAT_COLOR_PALETTE = [
  "#ffffff",
  "#f8fafc",
  "#fee2e2",
  "#ffedd5",
  "#fef3c7",
  "#dcfce7",
  "#ccfbf1",
  "#dbeafe",
  "#ede9fe",
  "#fce7f3",
  "#111827"
] as const;

export const DEFAULT_SHEET_VIEW_SETTING: SheetViewSettingState = {
  alternateRowColors: false,
  alternateOddColor: "#ffffff",
  alternateEvenColor: "#f8fafc",
  fontSize: 14,
  columnWidths: {},
  condensedView: false,
  frozenHeaderRowIndex: null
};

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const HORIZONTAL_ALIGNMENTS = ["left", "center", "right"] as const;
const MIN_SHEET_FONT_SIZE = 8;
const MAX_SHEET_FONT_SIZE = 36;
const MIN_COLUMN_WIDTH = 1;
const MAX_COLUMN_WIDTH = 5000;

export function createDefaultCellFormat(): CellFormatState {
  return {
    bold: false,
    italic: false,
    underline: false,
    textColor: null,
    backgroundColor: null,
    horizontalAlign: null
  };
}

export function normalizeHexColor(value: unknown): string | null {
  const color = String(value ?? "").trim();

  if (!color || color === "transparent") {
    return null;
  }

  if (!HEX_COLOR_PATTERN.test(color)) {
    return null;
  }

  return color.toLowerCase();
}

export function normalizeSheetFontSize(value: unknown): number {
  const size = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(size)) {
    return DEFAULT_SHEET_VIEW_SETTING.fontSize;
  }

  return Math.min(MAX_SHEET_FONT_SIZE, Math.max(MIN_SHEET_FONT_SIZE, size));
}

export function normalizeSheetColumnWidths(
  value: unknown
): Partial<Record<ColumnKey, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const widths: Partial<Record<ColumnKey, number>> = {};
  const source = value as Record<string, unknown>;

  for (const columnKey of COLUMN_KEYS) {
    const width = Number(source[columnKey]);

    if (Number.isFinite(width)) {
      widths[columnKey] = Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, Math.round(width))
      );
    }
  }

  return widths;
}

export function normalizeSheetCondensedView(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "on";
}

export function normalizeSheetFrozenHeaderRowIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const rowIndex = Number.parseInt(String(value), 10);

  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > MAX_ROWS) {
    return null;
  }

  return rowIndex;
}

export function normalizeHorizontalAlign(value: unknown): HorizontalAlign | null {
  return HORIZONTAL_ALIGNMENTS.includes(value as HorizontalAlign)
    ? (value as HorizontalAlign)
    : null;
}

export function normalizeFormatPatch(format: CellFormatPatch): CellFormatPatch {
  return {
    bold: format.bold,
    italic: format.italic,
    underline: format.underline,
    textColor:
      "textColor" in format ? normalizeHexColor(format.textColor) : undefined,
    backgroundColor:
      "backgroundColor" in format ? normalizeHexColor(format.backgroundColor) : undefined,
    horizontalAlign:
      "horizontalAlign" in format
        ? normalizeHorizontalAlign(format.horizontalAlign)
        : undefined
  };
}

export function mergeCellFormat(
  currentFormat: CellFormatState,
  patch: CellFormatPatch
): CellFormatState {
  return {
    bold: "bold" in patch ? Boolean(patch.bold) : currentFormat.bold,
    italic: "italic" in patch ? Boolean(patch.italic) : currentFormat.italic,
    underline: "underline" in patch ? Boolean(patch.underline) : currentFormat.underline,
    textColor:
      "textColor" in patch ? patch.textColor ?? null : currentFormat.textColor,
    backgroundColor:
      "backgroundColor" in patch
        ? patch.backgroundColor ?? null
        : currentFormat.backgroundColor,
    horizontalAlign:
      "horizontalAlign" in patch
        ? patch.horizontalAlign ?? null
        : currentFormat.horizontalAlign
  };
}

export function isDefaultCellFormat(format: CellFormatState): boolean {
  return (
    !format.bold &&
    !format.italic &&
    !format.underline &&
    !format.textColor &&
    !format.backgroundColor &&
    !format.horizontalAlign
  );
}
