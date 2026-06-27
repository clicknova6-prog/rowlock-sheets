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
  alternateEvenColor: "#f8fafc"
};

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const HORIZONTAL_ALIGNMENTS = ["left", "center", "right"] as const;

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
