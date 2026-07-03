import { MAX_ROWS, isValidRowIndex } from "@/lib/constants";

export interface ParsedRowIndexList {
  rowIndexes: number[];
  invalidTokens: string[];
}

export function parseRowIndexList(
  value: string,
  maxCount = MAX_ROWS
): ParsedRowIndexList {
  const rowIndexes = new Set<number>();
  const invalidTokens: string[] = [];
  const tokens = value
    .replace(/(\d+)\s*-\s*(\d+)/g, "$1-$2")
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);

    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      const min = Math.min(start, end);
      const max = Math.max(start, end);

      if (!isValidRowIndex(min) || !isValidRowIndex(max)) {
        invalidTokens.push(token);
        continue;
      }

      for (let rowIndex = min; rowIndex <= max; rowIndex += 1) {
        rowIndexes.add(rowIndex);

        if (rowIndexes.size > maxCount) {
          invalidTokens.push(`more than ${maxCount} rows`);
          break;
        }
      }

      continue;
    }

    const rowIndex = Number.parseInt(token, 10);

    if (!/^\d+$/.test(token) || !isValidRowIndex(rowIndex)) {
      invalidTokens.push(token);
      continue;
    }

    rowIndexes.add(rowIndex);

    if (rowIndexes.size > maxCount) {
      invalidTokens.push(`more than ${maxCount} rows`);
      break;
    }
  }

  return {
    rowIndexes: [...rowIndexes].sort((a, b) => a - b).slice(0, maxCount),
    invalidTokens
  };
}
