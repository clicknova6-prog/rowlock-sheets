export const COLUMN_KEYS = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z"
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const MAX_ROWS = 1000;

export function isColumnKey(value: string): value is ColumnKey {
  return COLUMN_KEYS.includes(value as ColumnKey);
}

export function assertColumnKey(value: string): ColumnKey {
  if (!isColumnKey(value)) {
    throw new Error(`Column ${value} is outside the fixed A-Z range.`);
  }

  return value;
}

export function isValidRowIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ROWS;
}

export function getCellKey(rowIndex: number, columnKey: string): string {
  return `${rowIndex}:${columnKey}`;
}
