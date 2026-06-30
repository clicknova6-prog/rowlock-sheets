"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from "react";
import {
  AlertCircle,
  Bold,
  CheckCircle2,
  Eraser,
  History,
  Italic,
  Lock,
  LockKeyhole,
  PaintBucket,
  Palette,
  Rows3,
  Save,
  ShieldCheck,
  Sigma,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Underline,
  UsersRound,
  X
} from "lucide-react";
import {
  Cell,
  DataGrid,
  Row,
  type CellRendererProps,
  type Column,
  type ColumnWidth,
  type ColumnWidths,
  type DataGridHandle,
  type FillEvent,
  type RenderRowProps,
  type RenderEditCellProps,
  type Renderers,
  type RowsChangeData
} from "react-data-grid";
import clsx from "clsx";
import { Role } from "@/generated/prisma/enums";
import { MAX_ROWS, getCellKey } from "@/lib/constants";
import type { ColumnKey } from "@/lib/constants";
import { useSheet } from "@/hooks/useSheet";
import { useSheetPresence } from "@/hooks/useSheetPresence";
import { useSheetRealtime } from "@/hooks/useSheetRealtime";
import { FORMAT_COLOR_PALETTE, createDefaultCellFormat } from "@/lib/sheet/formatting";
import { getCellEditDecision } from "@/lib/sheet/permissions";
import type { SheetRealtimeEvent } from "@/lib/sheet/realtime-types";
import type {
  CellChangedPayload,
  CellErrorPayload,
  CellLockedPayload,
  CellUnlockedPayload,
  CellsChangedPayload,
  RowClaimedPayload,
  SheetLocksPayload
} from "@/lib/sheet/socket-types";
import type {
  CellFormatPatch,
  CellFormatState,
  CellHistoryEntryState,
  HorizontalAlign,
  SheetGridRow,
  SheetSnapshot,
  SheetViewSettingState
} from "@/lib/sheet/types";

interface SpreadsheetWorkspaceProps {
  initialSnapshot: SheetSnapshot;
  demoMode?: boolean;
}

interface SelectedCell {
  rowIndex: number;
  columnKey: ColumnKey;
}

interface SelectedCellRange {
  anchor: SelectedCell;
  focus: SelectedCell;
}

interface NormalizedCellRange {
  startRow: number;
  endRow: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

interface CellUpdateDraft {
  rowIndex: number;
  columnKey: ColumnKey;
  value: string;
}

interface CellHistoryPanelState {
  cell: SelectedCell;
  entries: CellHistoryEntryState[];
  loading: boolean;
  error: string | null;
}

interface ColumnCheckDialogState {
  columnKey: ColumnKey;
  text: string;
}

interface CellEditHistoryEntry {
  undo: CellUpdateDraft[];
  redo: CellUpdateDraft[];
}

interface CellLockState {
  userId: string;
  userColor: string;
}

interface FormatButtonProps {
  title: string;
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}

type DemoEngineModule = typeof import("@/lib/sheet/demo-engine");

const CELL_AUTOSAVE_DEBOUNCE_MS = 750;
const BULK_AUTOSAVE_DEBOUNCE_MS = 150;
const AUTOSAVE_MAX_BATCH_SIZE = 200;
const SOCKET_BULK_UPDATE_LIMIT = 1000;
const REST_BULK_UPDATE_LIMIT = 200;
const LIVE_SYNC_ACK_TIMEOUT_MS = 300000;
const REALTIME_SNAPSHOT_REFRESH_MS = 400;
const DEFAULT_DATA_COLUMN_WIDTH = 230;
const CELL_HORIZONTAL_PADDING_PX = 18;
const SELECTION_AUTO_SCROLL_EDGE_PX = 56;
const SELECTION_AUTO_SCROLL_MAX_PX = 28;
const MAX_CELL_HISTORY_ENTRIES = 100;
let demoEnginePromise: Promise<DemoEngineModule> | null = null;

function loadDemoEngine(): Promise<DemoEngineModule> {
  demoEnginePromise ??= import("@/lib/sheet/demo-engine");
  return demoEnginePromise;
}

interface SelectionAutoScrollState {
  frameId: number | null;
  velocityX: number;
  velocityY: number;
  pointerX: number;
  pointerY: number;
}

function isColumnKey(value: string, columns: ColumnKey[]): value is ColumnKey {
  return columns.includes(value as ColumnKey);
}

function getRawCellValue(row: SheetGridRow | undefined, columnKey: ColumnKey): string {
  return row ? String(row[columnKey] ?? "") : "";
}

function getCellLockMapKey(rowIndex: number, columnKey: ColumnKey): string {
  return getCellKey(rowIndex, columnKey);
}

function isCellLockedByOther(
  locks: Map<string, CellLockState>,
  rowIndex: number,
  columnKey: ColumnKey,
  currentUserId: string
): boolean {
  const lock = locks.get(getCellLockMapKey(rowIndex, columnKey));
  return Boolean(lock && lock.userId !== currentUserId);
}

function getUserInitials(userId: string): string {
  return userId.slice(0, 2).toUpperCase();
}

function getDisplayInitials(name: string, userId: string): string {
  const nameParts = name.trim().split(/\s+/).filter(Boolean);

  if (nameParts.length >= 2) {
    return `${nameParts[0][0]}${nameParts[1][0]}`.toUpperCase();
  }

  return (nameParts[0] ?? userId).slice(0, 2).toUpperCase();
}

function getRenderedCellValue(row: SheetGridRow, columnKey: ColumnKey): string {
  return row.__formula[columnKey]
    ? row.__computed[columnKey]
    : String(row[columnKey] ?? "");
}

function renderWrappedCellText(value: string): React.ReactNode {
  if (!value) {
    return null;
  }

  return value.split(/(\r\n|\r|\n|\s+)/).map((segment, index) => {
    if (segment === "\r\n" || segment === "\r" || segment === "\n") {
      return <br key={index} />;
    }

    if (/^\s+$/.test(segment)) {
      return " ";
    }

    return (
      <span className="sheet-cell-word" key={index}>
        {segment}
      </span>
    );
  });
}

function createColumnWidthsFromViewSetting(
  widths: SheetViewSettingState["columnWidths"]
): ColumnWidths {
  const columnWidths = new Map<string, ColumnWidth>();

  for (const [columnKey, width] of Object.entries(widths)) {
    const numericWidth = Number(width);

    if (Number.isFinite(numericWidth) && numericWidth > 0) {
      columnWidths.set(columnKey, {
        type: "resized",
        width: Math.round(numericWidth)
      });
    }
  }

  return columnWidths;
}

function serializeColumnWidths(
  widths: ColumnWidths,
  columns: ColumnKey[]
): Partial<Record<ColumnKey, number>> {
  const serialized: Partial<Record<ColumnKey, number>> = {};

  for (const columnKey of columns) {
    const width = Number(widths.get(columnKey)?.width);

    if (Number.isFinite(width) && width > 0) {
      serialized[columnKey] = Math.round(width);
    }
  }

  return serialized;
}

function getSelectionEdgeVelocity(distance: number): number {
  if (distance <= 0) {
    return 0;
  }

  const intensity = Math.min(1, distance / SELECTION_AUTO_SCROLL_EDGE_PX);
  return Math.max(1, Math.round(intensity * SELECTION_AUTO_SCROLL_MAX_PX));
}

function getSelectionAutoScrollVelocity(
  clientX: number,
  clientY: number,
  rect: DOMRect
): Pick<SelectionAutoScrollState, "velocityX" | "velocityY"> {
  let velocityX = 0;
  let velocityY = 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const visibleLeft = Math.max(rect.left, 0);
  const visibleRight = Math.min(rect.right, viewportWidth);
  const visibleTop = Math.max(rect.top, 0);
  const visibleBottom = Math.min(rect.bottom, viewportHeight);
  const edgeRect =
    visibleRight > visibleLeft && visibleBottom > visibleTop
      ? {
          left: visibleLeft,
          right: visibleRight,
          top: visibleTop,
          bottom: visibleBottom
        }
      : rect;

  if (clientX < edgeRect.left + SELECTION_AUTO_SCROLL_EDGE_PX) {
    velocityX = -getSelectionEdgeVelocity(edgeRect.left + SELECTION_AUTO_SCROLL_EDGE_PX - clientX);
  } else if (clientX > edgeRect.right - SELECTION_AUTO_SCROLL_EDGE_PX) {
    velocityX = getSelectionEdgeVelocity(clientX - (edgeRect.right - SELECTION_AUTO_SCROLL_EDGE_PX));
  }

  if (clientY < edgeRect.top + SELECTION_AUTO_SCROLL_EDGE_PX) {
    velocityY = -getSelectionEdgeVelocity(edgeRect.top + SELECTION_AUTO_SCROLL_EDGE_PX - clientY);
  } else if (clientY > edgeRect.bottom - SELECTION_AUTO_SCROLL_EDGE_PX) {
    velocityY = getSelectionEdgeVelocity(clientY - (edgeRect.bottom - SELECTION_AUTO_SCROLL_EDGE_PX));
  }

  return { velocityX, velocityY };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function clampPointerToRect(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
  return {
    x: Math.min(rect.right - 1, Math.max(rect.left + 1, clientX)),
    y: Math.min(rect.bottom - 1, Math.max(rect.top + 1, clientY))
  };
}

function getSheetCellFromPoint(
  clientX: number,
  clientY: number,
  columns: ColumnKey[],
  rect?: DOMRect
): SelectedCell | null {
  const pointer = rect ? clampPointerToRect(clientX, clientY, rect) : { x: clientX, y: clientY };
  const element = document.elementFromPoint(pointer.x, pointer.y);
  const cellElement = element?.closest<HTMLElement>("[data-sheet-row-index][data-sheet-column-key]");

  if (!cellElement) {
    return null;
  }

  const rowIndex = Number(cellElement.dataset.sheetRowIndex);
  const columnKey = cellElement.dataset.sheetColumnKey;

  if (!Number.isInteger(rowIndex) || !columnKey || !isColumnKey(columnKey, columns)) {
    return null;
  }

  return { rowIndex, columnKey };
}

function createCellEditHistoryEntry(
  previousRows: SheetGridRow[],
  updates: CellUpdateDraft[]
): CellEditHistoryEntry | null {
  const rowsByNumber = new Map(previousRows.map((row) => [row.rowNumber, row]));
  const undoByCell = new Map<string, CellUpdateDraft>();
  const redoByCell = new Map<string, CellUpdateDraft>();

  for (const update of updates) {
    const row = rowsByNumber.get(update.rowIndex);

    if (!row) {
      continue;
    }

    const previousValue = getRawCellValue(row, update.columnKey);

    if (previousValue === update.value) {
      continue;
    }

    const key = getCellKey(update.rowIndex, update.columnKey);
    undoByCell.set(key, {
      rowIndex: update.rowIndex,
      columnKey: update.columnKey,
      value: previousValue
    });
    redoByCell.set(key, update);
  }

  const undo = [...undoByCell.values()];
  const redo = [...redoByCell.values()];

  return undo.length > 0 && redo.length > 0 ? { undo, redo } : null;
}

function countEditableColumns(snapshot: SheetSnapshot): number {
  return snapshot.columnPermissions.filter((permission) => permission.editableByMember).length;
}

function estimateTextSegmentLineCount(
  segment: string,
  charactersPerLine: number
): number {
  if (!segment) {
    return 1;
  }

  const words = segment.split(/(\s+)/);
  let lineCount = 1;
  let currentLineLength = 0;

  for (const word of words) {
    if (!word) {
      continue;
    }

    const wordLength = word.length;

    if (/^\s+$/.test(word)) {
      if (currentLineLength > 0 && currentLineLength + 1 <= charactersPerLine) {
        currentLineLength += 1;
      }
      continue;
    }

    if (wordLength > charactersPerLine) {
      const remainingSpace =
        currentLineLength > 0 ? Math.max(0, charactersPerLine - currentLineLength) : 0;
      const overflowLength = remainingSpace > 0 ? Math.max(0, wordLength - remainingSpace) : wordLength;
      const extraLines = Math.ceil(overflowLength / charactersPerLine);

      lineCount += extraLines;
      currentLineLength = overflowLength % charactersPerLine;
      continue;
    }

    if (currentLineLength === 0) {
      currentLineLength = wordLength;
    } else if (currentLineLength + 1 + wordLength <= charactersPerLine) {
      currentLineLength += 1 + wordLength;
    } else {
      lineCount += 1;
      currentLineLength = wordLength;
    }
  }

  return lineCount;
}

function estimateWrappedLineCount(value: string, columnWidth: number, fontSize: number): number {
  if (!value) {
    return 1;
  }

  const usableWidth = Math.max(24, columnWidth - CELL_HORIZONTAL_PADDING_PX);
  const averageCharacterWidth = Math.max(5, fontSize * 0.52);
  const charactersPerLine = Math.max(1, Math.floor(usableWidth / averageCharacterWidth));
  const lines = value.split(/\r\n|\r|\n/);

  return lines.reduce((count, line) => {
    return count + estimateTextSegmentLineCount(line, charactersPerLine);
  }, 0);
}

function getResponsiveRowHeight(
  row: SheetGridRow,
  columns: ColumnKey[],
  fontSize: number,
  columnWidths: ColumnWidths
): number {
  const maxLines = columns.reduce((lineCount, columnKey) => {
    const cellValue = getRenderedCellValue(row, columnKey);
    const columnWidth = columnWidths.get(columnKey)?.width ?? DEFAULT_DATA_COLUMN_WIDTH;

    return Math.max(lineCount, estimateWrappedLineCount(cellValue, columnWidth, fontSize));
  }, 1);
  const lineHeight = Math.max(14, fontSize * 1.35);
  const minimumHeight = Math.max(34, fontSize * 2.4);

  return Math.min(260, Math.ceil(Math.max(minimumHeight, maxLines * lineHeight + 12)));
}

function parseClipboardGrid(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => line.split("\t"));
}

function parseColumnCheckTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const value of text.split(/\s+/)) {
    const term = value.trim();

    if (term) {
      terms.add(term);
    }

    if (terms.size >= 500) {
      break;
    }
  }

  return [...terms];
}

function getNormalizedCellRange(
  range: SelectedCellRange | null,
  columns: ColumnKey[]
): NormalizedCellRange | null {
  if (!range) {
    return null;
  }

  const anchorColumnIndex = columns.indexOf(range.anchor.columnKey);
  const focusColumnIndex = columns.indexOf(range.focus.columnKey);

  if (anchorColumnIndex < 0 || focusColumnIndex < 0) {
    return null;
  }

  return {
    startRow: Math.min(range.anchor.rowIndex, range.focus.rowIndex),
    endRow: Math.max(range.anchor.rowIndex, range.focus.rowIndex),
    startColumnIndex: Math.min(anchorColumnIndex, focusColumnIndex),
    endColumnIndex: Math.max(anchorColumnIndex, focusColumnIndex)
  };
}

function isCellInsideRange(
  rowIndex: number,
  columnKey: ColumnKey,
  range: SelectedCellRange | null,
  columns: ColumnKey[]
): boolean {
  const normalizedRange = getNormalizedCellRange(range, columns);

  if (!normalizedRange) {
    return false;
  }

  const columnIndex = columns.indexOf(columnKey);

  return (
    rowIndex >= normalizedRange.startRow &&
    rowIndex <= normalizedRange.endRow &&
    columnIndex >= normalizedRange.startColumnIndex &&
    columnIndex <= normalizedRange.endColumnIndex
  );
}

function getCellRangeLabel(range: SelectedCellRange | null, columns: ColumnKey[]): string {
  const normalizedRange = getNormalizedCellRange(range, columns);

  if (!normalizedRange) {
    return "--";
  }

  const startColumn = columns[normalizedRange.startColumnIndex];
  const endColumn = columns[normalizedRange.endColumnIndex];

  if (
    normalizedRange.startRow === normalizedRange.endRow &&
    normalizedRange.startColumnIndex === normalizedRange.endColumnIndex
  ) {
    return `${startColumn}${normalizedRange.startRow}`;
  }

  return `${startColumn}${normalizedRange.startRow}:${endColumn}${normalizedRange.endRow}`;
}

function getRangeStartCell(
  range: SelectedCellRange | null,
  columns: ColumnKey[]
): SelectedCell | null {
  const normalizedRange = getNormalizedCellRange(range, columns);

  if (!normalizedRange) {
    return null;
  }

  return {
    rowIndex: normalizedRange.startRow,
    columnKey: columns[normalizedRange.startColumnIndex]
  };
}

function serializeCellRange(
  rows: SheetGridRow[],
  columns: ColumnKey[],
  range: SelectedCellRange | null
): string {
  const normalizedRange = getNormalizedCellRange(range, columns);

  if (!normalizedRange) {
    return "";
  }

  const rowsByNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const lines: string[] = [];

  for (let rowIndex = normalizedRange.startRow; rowIndex <= normalizedRange.endRow; rowIndex += 1) {
    const row = rowsByNumber.get(rowIndex);
    const values: string[] = [];

    for (
      let columnIndex = normalizedRange.startColumnIndex;
      columnIndex <= normalizedRange.endColumnIndex;
      columnIndex += 1
    ) {
      const columnKey = columns[columnIndex];
      values.push(row ? getRenderedCellValue(row, columnKey) : "");
    }

    lines.push(values.join("\t"));
  }

  return lines.join("\n");
}

function getRangeCellUpdates(
  rows: SheetGridRow[],
  columns: ColumnKey[],
  range: SelectedCellRange | null,
  value: string
): CellUpdateDraft[] {
  const normalizedRange = getNormalizedCellRange(range, columns);

  if (!normalizedRange) {
    return [];
  }

  const rowsByNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const updates: CellUpdateDraft[] = [];

  for (let rowIndex = normalizedRange.startRow; rowIndex <= normalizedRange.endRow; rowIndex += 1) {
    const row = rowsByNumber.get(rowIndex);

    if (!row) {
      continue;
    }

    for (
      let columnIndex = normalizedRange.startColumnIndex;
      columnIndex <= normalizedRange.endColumnIndex;
      columnIndex += 1
    ) {
      const columnKey = columns[columnIndex];

      if (!row.__editable[columnKey] || getRawCellValue(row, columnKey) === value) {
        continue;
      }

      updates.push({
        rowIndex,
        columnKey,
        value
      });
    }
  }

  return updates;
}

function applyUpdatesToRows(
  rows: SheetGridRow[],
  updates: CellUpdateDraft[]
): SheetGridRow[] {
  const updatesByRow = new Map<number, CellUpdateDraft[]>();

  for (const update of updates) {
    const rowUpdates = updatesByRow.get(update.rowIndex) ?? [];
    rowUpdates.push(update);
    updatesByRow.set(update.rowIndex, rowUpdates);
  }

  return rows.map((row) => {
    const rowUpdates = updatesByRow.get(row.rowNumber);

    if (!rowUpdates) {
      return row;
    }

    return rowUpdates.reduce<SheetGridRow>(
      (nextRow, update) => ({
        ...nextRow,
        [update.columnKey]: update.value
      }),
      row
    );
  });
}

function mergeRowsByNumber(
  currentRows: SheetGridRow[],
  incomingRows: SheetGridRow[]
): SheetGridRow[] {
  if (incomingRows.length === 0) {
    return currentRows;
  }

  const incomingLookup = new Map(incomingRows.map((row) => [row.rowNumber, row]));
  return currentRows.map((row) => incomingLookup.get(row.rowNumber) ?? row);
}

function createClientInstanceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function recomputeRowsForCurrentUser(
  rows: SheetGridRow[],
  snapshot: SheetSnapshot
): SheetGridRow[] {
  return rows.map((row) => {
    const ownership = row.ownerId
      ? {
          rowIndex: row.rowNumber,
          ownerId: row.ownerId,
          ownerName: row.ownerName,
          updatedAt: row.updatedAt
        }
      : null;
    const editable = { ...row.__editable };
    const lockReason = { ...row.__lockReason };

    for (const columnKey of snapshot.columns) {
      const decision = getCellEditDecision({
        role: snapshot.currentUser.role,
        userId: snapshot.currentUser.id,
        columnKey,
        columnPermissions: snapshot.columnPermissions,
        ownership,
        currentValue: getRawCellValue(row, columnKey)
      });

      editable[columnKey] = decision.allowed;
      lockReason[columnKey] = decision.reason;
    }

    return {
      ...row,
      __editable: editable,
      __lockReason: lockReason
    };
  });
}

function getCellFormat(row: SheetGridRow | undefined, columnKey: ColumnKey): CellFormatState {
  return row?.__format[columnKey] ?? createDefaultCellFormat();
}

function getCellTextStyle(format: CellFormatState): CSSProperties | undefined {
  const style: CSSProperties = {};

  if (format.textColor) {
    style.color = getThemeAwareTextColor(format.textColor);
  }

  if (format.bold) {
    style.fontWeight = 700;
  }

  if (format.italic) {
    style.fontStyle = "italic";
  }

  if (format.underline) {
    style.textDecoration = "underline";
  }

  if (format.horizontalAlign) {
    style.textAlign = format.horizontalAlign;
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function getReadableTextColorForBackground(backgroundColor: string | undefined): string | undefined {
  if (backgroundColor === "var(--grid-match-bg)") {
    return "var(--grid-match-text)";
  }

  if (backgroundColor === "var(--grid-duplicate-bg)") {
    return "var(--grid-duplicate-text)";
  }

  if (!backgroundColor || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
    return backgroundColor?.startsWith("var(--grid-fill-")
      ? "var(--grid-fill-text)"
      : undefined;
  }

  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.55 ? "#111827" : "#f8fafc";
}

function getThemeAwareTextColor(textColor: string | null | undefined): string | undefined {
  switch (textColor?.toLowerCase()) {
    case "#000000":
    case "#111827":
      return "var(--text)";
    default:
      return textColor ?? undefined;
  }
}

function getThemeAwareCellBackgroundColor(backgroundColor: string | null | undefined): string | undefined {
  switch (backgroundColor?.toLowerCase()) {
    case "#ffffff":
      return "var(--grid-cell-bg)";
    case "#f8fafc":
      return "var(--grid-alt-even-bg)";
    case "#fee2e2":
      return "var(--grid-fill-red-bg)";
    case "#ffedd5":
      return "var(--grid-fill-orange-bg)";
    case "#fef3c7":
      return "var(--grid-fill-yellow-bg)";
    case "#dcfce7":
      return "var(--grid-fill-green-bg)";
    case "#ccfbf1":
      return "var(--grid-fill-teal-bg)";
    case "#dbeafe":
      return "var(--grid-fill-blue-bg)";
    case "#ede9fe":
      return "var(--grid-fill-violet-bg)";
    case "#fce7f3":
      return "var(--grid-fill-pink-bg)";
    default:
      return backgroundColor ?? undefined;
  }
}

function getThemeAwareRowBackgroundColor(
  backgroundColor: string | null | undefined,
  rowNumber: number
): string | undefined {
  switch (backgroundColor?.toLowerCase()) {
    case "#ffffff":
      return rowNumber % 2 === 0 ? "var(--grid-alt-even-bg)" : "var(--grid-alt-odd-bg)";
    case "#f8fafc":
      return "var(--grid-alt-even-bg)";
    default:
      return backgroundColor ?? undefined;
  }
}

function getCellContainerStyle(
  baseStyle: CSSProperties | undefined,
  format: CellFormatState
): CSSProperties | undefined {
  const backgroundColor = getThemeAwareCellBackgroundColor(format.backgroundColor);

  if (!backgroundColor) {
    return baseStyle;
  }

  return {
    ...baseStyle,
    backgroundColor,
    ...(!format.textColor
      ? { color: getReadableTextColorForBackground(backgroundColor) }
      : {})
  };
}

function getAlternateRowBackground(
  row: SheetGridRow,
  viewSetting: SheetViewSettingState
): string | undefined {
  if (row.__matchHighlight) {
    return "var(--grid-match-bg)";
  }

  if (row.__duplicateHighlight) {
    return "var(--grid-duplicate-bg)";
  }

  if (!viewSetting.alternateRowColors) {
    return undefined;
  }

  const backgroundColor = row.rowNumber % 2 === 0
    ? viewSetting.alternateEvenColor
    : viewSetting.alternateOddColor;

  return getThemeAwareRowBackgroundColor(backgroundColor, row.rowNumber);
}

function FormatIconButton({
  title,
  active = false,
  children,
  onClick
}: FormatButtonProps) {
  return (
    <button
      aria-pressed={active}
      className={clsx(
        "focus-ring inline-flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--line)] transition hover:bg-[color:var(--panel-muted)]",
        active && "border-[color:var(--accent)] bg-[color:var(--panel-muted)] text-[color:var(--accent)]"
      )}
      title={title}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ToolbarTextButton({
  title,
  active = false,
  disabled = false,
  children,
  onClick
}: FormatButtonProps & { disabled?: boolean }) {
  return (
    <button
      aria-pressed={active}
      className={clsx(
        "focus-ring inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[color:var(--line)] px-2 text-xs font-semibold transition hover:bg-[color:var(--panel-muted)]",
        active && "border-[color:var(--accent)] bg-[color:var(--panel-muted)] text-[color:var(--accent)]",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent"
      )}
      disabled={disabled}
      title={title}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColorSwatch({
  color,
  selected,
  title,
  onClick
}: {
  color: string;
  selected: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "focus-ring h-7 w-7 rounded-md border border-[color:var(--line)] p-0.5 transition hover:scale-105",
        selected && "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]"
      )}
      title={title}
      type="button"
      onClick={onClick}
    >
      <span
        className="block h-full w-full rounded"
        style={{ backgroundColor: color }}
      />
    </button>
  );
}

function getMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : String(value);
}

function getDemoCellHistory(
  snapshot: SheetSnapshot,
  cell: SelectedCell
): CellHistoryEntryState[] {
  return snapshot.auditLogs
    .filter(
      (log) =>
        log.rowIndex === cell.rowIndex &&
        log.columnKey === cell.columnKey &&
        (log.action === "CELL_UPDATED" || log.action === "CELL_FORMAT_UPDATED")
    )
    .map((log) => ({
      id: log.id,
      action: log.action,
      actorName: log.actorName,
      message: log.message,
      previousValue: getMetadataString(log.metadata, "previousValue"),
      value: getMetadataString(log.metadata, "value"),
      previousComputedValue: getMetadataString(log.metadata, "previousComputedValue"),
      computedValue: getMetadataString(log.metadata, "computedValue"),
      previousFormula: getMetadataString(log.metadata, "previousFormula"),
      formula: getMetadataString(log.metadata, "formula"),
      createdAt: log.createdAt
    }));
}

export function SpreadsheetWorkspace({
  initialSnapshot,
  demoMode = false
}: SpreadsheetWorkspaceProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [rows, setRows] = useState(initialSnapshot.rows);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() =>
    createColumnWidthsFromViewSetting(initialSnapshot.viewSetting.columnWidths)
  );
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [selectedRange, setSelectedRange] = useState<SelectedCellRange | null>(null);
  const [isRangeSelecting, setIsRangeSelecting] = useState(false);
  const [fillColor, setFillColor] = useState("#fef3c7");
  const [textColor, setTextColor] = useState("#111827");
  const [historyPanel, setHistoryPanel] = useState<CellHistoryPanelState | null>(null);
  const [columnCheckDialog, setColumnCheckDialog] =
    useState<ColumnCheckDialogState | null>(null);
  const [locks, setLocks] = useState<Map<string, CellLockState>>(new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [isSavingCells, setIsSavingCells] = useState(false);
  const [isPending, startTransition] = useTransition();
  const latestSnapshotRef = useRef(initialSnapshot);
  const rowsRef = useRef(initialSnapshot.rows);
  const saveQueueRef = useRef<Map<string, CellUpdateDraft>>(new Map());
  const inFlightUpdatesRef = useRef<Map<string, CellUpdateDraft>>(new Map());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const columnWidthSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridShellRef = useRef<HTMLDivElement | null>(null);
  const dataGridRef = useRef<DataGridHandle | null>(null);
  const selectedCellRef = useRef<SelectedCell | null>(null);
  const selectedRangeRef = useRef<SelectedCellRange | null>(null);
  const isRangeSelectingRef = useRef(false);
  const selectionKeyboardActiveRef = useRef(false);
  const selectionAutoScrollRef = useRef<SelectionAutoScrollState>({
    frameId: null,
    velocityX: 0,
    velocityY: 0,
    pointerX: 0,
    pointerY: 0
  });
  const runSelectionAutoScrollRef = useRef<() => void>(() => undefined);
  const undoStackRef = useRef<CellEditHistoryEntry[]>([]);
  const redoStackRef = useRef<CellEditHistoryEntry[]>([]);
  const saveInFlightRef = useRef(false);
  const flushQueuedCellUpdatesRef = useRef<() => Promise<boolean>>(async () => true);
  const activeSocketCellRef = useRef<SelectedCell | null>(null);
  const clientInstanceIdRef = useRef(createClientInstanceId());
  const socketConnectedRef = useRef(false);
  const socketUpdateCellRef = useRef<(update: CellUpdateDraft) => boolean>(() => false);
  const socketUpdateCellsRef = useRef<(updates: CellUpdateDraft[]) => boolean>(() => false);
  const socketFocusCellRef = useRef<(cell: SelectedCell) => void>(() => undefined);
  const socketBlurCellRef = useRef<(cell: SelectedCell) => void>(() => undefined);

  const socketSyncEnabled = !demoMode && process.env.NEXT_PUBLIC_ENABLE_SOCKET_SYNC !== "false";
  const firestoreSyncEnabled =
    !demoMode &&
    !socketSyncEnabled &&
    process.env.NEXT_PUBLIC_ENABLE_FIRESTORE_SYNC !== "false";
  const isAdmin = snapshot.currentUser.role === Role.ADMIN;
  const selectedStartCell = getRangeStartCell(selectedRange, snapshot.columns) ?? selectedCell;
  const selectedRow = selectedCell
    ? rows.find((row) => row.rowNumber === selectedCell.rowIndex)
    : undefined;
  const selectedStartRow = selectedStartCell
    ? rows.find((row) => row.rowNumber === selectedStartCell.rowIndex)
    : undefined;
  const selectedFormat = selectedStartCell
    ? getCellFormat(selectedStartRow, selectedStartCell.columnKey)
    : createDefaultCellFormat();
  const selectedRawValue = selectedCell
    ? getRawCellValue(selectedRow, selectedCell.columnKey)
    : "";
  const selectedComputedValue =
    selectedCell && selectedRow?.__formula[selectedCell.columnKey]
      ? selectedRow.__computed[selectedCell.columnKey]
      : "";
  const selectedCellLock = selectedCell
    ? locks.get(getCellLockMapKey(selectedCell.rowIndex, selectedCell.columnKey))
    : null;
  const selectedLockReason =
    selectedCellLock && selectedCellLock.userId !== snapshot.currentUser.id
      ? "This cell is being edited by another user."
      : selectedCell && selectedRow
        ? selectedRow.__lockReason[selectedCell.columnKey]
        : null;
  const selectedRenderedValue =
    selectedCell && selectedRow ? getRenderedCellValue(selectedRow, selectedCell.columnKey) : "";
  const selectedAddressLabel = selectedRange
    ? getCellRangeLabel(selectedRange, snapshot.columns)
    : selectedCell
      ? `${selectedCell.columnKey}${selectedCell.rowIndex}`
      : "--";
  const selectedAdminColumnKey = selectedStartCell?.columnKey ?? null;
  const selectedAdminRowIndex = selectedStartCell?.rowIndex ?? null;
  const selectedColumnPermission = selectedAdminColumnKey
    ? snapshot.columnPermissions.find(
        (permission) => permission.columnKey === selectedAdminColumnKey
      ) ?? null
    : null;
  const selectedClipboardValue = selectedRange
    ? serializeCellRange(rows, snapshot.columns, selectedRange)
    : selectedRenderedValue;
  const statusMessage =
    error ??
    message ??
    (isSavingCells
      ? socketSyncEnabled
        ? "Syncing..."
        : "Saving..."
      : pendingSaveCount > 0
        ? `${socketSyncEnabled ? "Live sync" : "Save"} queued for ${pendingSaveCount} cell${pendingSaveCount === 1 ? "" : "s"}.`
        : "Ready");
  const rowHeight = useCallback(
    (row: SheetGridRow) =>
      getResponsiveRowHeight(row, snapshot.columns, snapshot.viewSetting.fontSize, columnWidths),
    [columnWidths, snapshot.columns, snapshot.viewSetting.fontSize]
  );
  const persistColumnWidths = useCallback(async (
    nextColumnWidths: Partial<Record<ColumnKey, number>>
  ): Promise<void> => {
    if (demoMode || !isAdmin) {
      return;
    }

    try {
      const response = await fetch("/api/sheets/view-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetId: latestSnapshotRef.current.sheet.id,
          columnWidths: nextColumnWidths
        })
      });
      const body = (await response.json().catch(() => null)) as {
        viewSetting?: SheetViewSettingState;
        error?: string;
      } | null;

      if (!response.ok || !body?.viewSetting) {
        throw new Error(body?.error ?? "Column widths could not be saved.");
      }

      const currentSnapshot = latestSnapshotRef.current;
      const nextSnapshot = {
        ...currentSnapshot,
        viewSetting: body.viewSetting
      };

      latestSnapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setMessage("Column widths saved.");
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Column widths could not be saved.");
    }
  }, [demoMode, isAdmin]);
  const handleColumnWidthsChange = useCallback((nextColumnWidths: ColumnWidths): void => {
    setColumnWidths(nextColumnWidths);

    if (columnWidthSaveTimerRef.current) {
      clearTimeout(columnWidthSaveTimerRef.current);
      columnWidthSaveTimerRef.current = null;
    }

    if (demoMode || !isAdmin) {
      return;
    }

    const serializedWidths = serializeColumnWidths(nextColumnWidths, snapshot.columns);

    columnWidthSaveTimerRef.current = setTimeout(() => {
      columnWidthSaveTimerRef.current = null;
      void persistColumnWidths(serializedWidths);
    }, 700);
  }, [demoMode, isAdmin, persistColumnWidths, snapshot.columns]);
  const getGridScrollElement = useCallback((): HTMLElement | null => {
    return dataGridRef.current?.element ?? gridShellRef.current?.querySelector<HTMLElement>(".rdg") ?? null;
  }, []);
  const stopSelectionAutoScroll = useCallback((): void => {
    const autoScrollState = selectionAutoScrollRef.current;

    if (autoScrollState.frameId !== null) {
      window.cancelAnimationFrame(autoScrollState.frameId);
    }

    autoScrollState.frameId = null;
    autoScrollState.velocityX = 0;
    autoScrollState.velocityY = 0;
  }, []);
  const isSheetInteractionActive = useCallback((target: EventTarget | null): boolean => {
    const shell = gridShellRef.current;
    const targetNode = target instanceof Node ? target : null;
    const activeElement = document.activeElement;
    const eventStartedInGrid = Boolean(shell && targetNode && shell.contains(targetNode));
    const focusIsInGrid = Boolean(shell && activeElement && shell.contains(activeElement));

    return selectionKeyboardActiveRef.current || eventStartedInGrid || focusIsInGrid;
  }, []);

  useEffect(() => {
    latestSnapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    selectedCellRef.current = selectedCell;
  }, [selectedCell]);

  useEffect(() => {
    selectedRangeRef.current = selectedRange;
  }, [selectedRange]);

  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      if (saveQueueRef.current.size === 0 && !saveInFlightRef.current) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", warnBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
      if (inFlightTimeoutRef.current) {
        clearTimeout(inFlightTimeoutRef.current);
      }
      if (snapshotRefreshTimerRef.current) {
        clearTimeout(snapshotRefreshTimerRef.current);
      }
      if (columnWidthSaveTimerRef.current) {
        clearTimeout(columnWidthSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    isRangeSelectingRef.current = isRangeSelecting;

    if (!isRangeSelecting) {
      return;
    }

    function stopRangeSelection(): void {
      isRangeSelectingRef.current = false;
      setIsRangeSelecting(false);
      stopSelectionAutoScroll();
    }

    window.addEventListener("mouseup", stopRangeSelection);
    window.addEventListener("blur", stopRangeSelection);

    return () => {
      window.removeEventListener("mouseup", stopRangeSelection);
      window.removeEventListener("blur", stopRangeSelection);
      stopSelectionAutoScroll();
    };
  }, [isRangeSelecting, stopSelectionAutoScroll]);

  useEffect(() => {
    function markSelectionInactive(event: PointerEvent | FocusEvent): void {
      const shell = gridShellRef.current;
      const target = event.target instanceof Node ? event.target : null;

      if (!shell || !target || !shell.contains(target)) {
        selectionKeyboardActiveRef.current = false;
      }
    }

    document.addEventListener("pointerdown", markSelectionInactive);
    document.addEventListener("focusin", markSelectionInactive);

    return () => {
      document.removeEventListener("pointerdown", markSelectionInactive);
      document.removeEventListener("focusin", markSelectionInactive);
    };
  }, []);

  const clearAutosaveTimer = useCallback((): void => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const clearInFlightTimeout = useCallback((): void => {
    if (inFlightTimeoutRef.current) {
      clearTimeout(inFlightTimeoutRef.current);
      inFlightTimeoutRef.current = null;
    }
  }, []);

  const applyServerSnapshot = useCallback((serverSnapshot: SheetSnapshot): void => {
    latestSnapshotRef.current = serverSnapshot;
    setColumnWidths(createColumnWidthsFromViewSetting(serverSnapshot.viewSetting.columnWidths));

    const queuedUpdates = [
      ...inFlightUpdatesRef.current.values(),
      ...saveQueueRef.current.values()
    ];
    const nextRows =
      queuedUpdates.length > 0
        ? applyUpdatesToRows(serverSnapshot.rows, queuedUpdates)
        : serverSnapshot.rows;

    setSnapshot(serverSnapshot);
    setRows(nextRows);
    rowsRef.current = nextRows;
  }, []);

  const applyCommittedRows = useCallback((incomingRows: SheetGridRow[]): void => {
    const currentSnapshot = latestSnapshotRef.current;
    const mergedRows =
      incomingRows.length === currentSnapshot.rows.length
        ? incomingRows
        : mergeRowsByNumber(currentSnapshot.rows, incomingRows);
    const committedRows = recomputeRowsForCurrentUser(mergedRows, currentSnapshot);
    const committedSnapshot = {
      ...currentSnapshot,
      rows: committedRows
    };
    const optimisticUpdates = [
      ...inFlightUpdatesRef.current.values(),
      ...saveQueueRef.current.values()
    ];
    const visibleRows =
      optimisticUpdates.length > 0
        ? applyUpdatesToRows(committedRows, optimisticUpdates)
        : committedRows;

    latestSnapshotRef.current = committedSnapshot;
    setSnapshot(committedSnapshot);
    setRows(visibleRows);
    rowsRef.current = visibleRows;
  }, []);

  const scheduleQueuedSave = useCallback((delayMs = CELL_AUTOSAVE_DEBOUNCE_MS): void => {
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushQueuedCellUpdatesRef.current();
    }, delayMs);
  }, [clearAutosaveTimer]);

  const scheduleInFlightTimeout = useCallback((): void => {
    clearInFlightTimeout();
    inFlightTimeoutRef.current = setTimeout(() => {
      inFlightTimeoutRef.current = null;

      for (const [key, update] of inFlightUpdatesRef.current.entries()) {
        if (!saveQueueRef.current.has(key)) {
          saveQueueRef.current.set(key, update);
        }
      }

      inFlightUpdatesRef.current.clear();
      saveInFlightRef.current = false;
      setIsSavingCells(false);
      setPendingSaveCount(saveQueueRef.current.size);
      setMessage(null);
      setError("Live sync took too long to confirm. Changes are queued and will retry in smaller batches.");
      scheduleQueuedSave(1000);
    }, LIVE_SYNC_ACK_TIMEOUT_MS);
  }, [clearInFlightTimeout, scheduleQueuedSave]);

  const flushQueuedCellUpdates = useCallback(async (): Promise<boolean> => {
    if (demoMode) {
      return true;
    }

    if (saveInFlightRef.current) {
      return false;
    }

    const useSocket = socketConnectedRef.current;
    const batchLimit = useSocket ? SOCKET_BULK_UPDATE_LIMIT : REST_BULK_UPDATE_LIMIT;
    const queuedUpdates = [...saveQueueRef.current.values()];
    const updates = queuedUpdates.slice(0, batchLimit);
    const remainingUpdates = queuedUpdates.slice(batchLimit);

    if (updates.length === 0) {
      return true;
    }

    clearAutosaveTimer();
    saveQueueRef.current.clear();
    for (const update of remainingUpdates) {
      saveQueueRef.current.set(getCellKey(update.rowIndex, update.columnKey), update);
    }
    setPendingSaveCount(saveQueueRef.current.size);
    saveInFlightRef.current = true;
    setIsSavingCells(true);
    setError(null);
    setMessage(`${useSocket ? "Syncing" : "Saving"} ${updates.length} cell${updates.length === 1 ? "" : "s"}...`);

    if (!useSocket) {
      try {
        const response = await fetch("/api/cells", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sheetId: latestSnapshotRef.current.sheet.id,
            updates,
            sourceClientId: clientInstanceIdRef.current
          })
        });
        const body = (await response.json().catch(() => null)) as {
          snapshot?: SheetSnapshot;
          rows?: SheetGridRow[];
          error?: string;
        } | null;

        if (!response.ok || (!body?.snapshot && !body?.rows)) {
          throw new Error(body?.error ?? "Unable to save queued changes.");
        }

        saveInFlightRef.current = false;
        setIsSavingCells(false);
        if (body.snapshot) {
          applyServerSnapshot(body.snapshot);
        } else if (body.rows) {
          applyCommittedRows(body.rows);
        }
        setPendingSaveCount(saveQueueRef.current.size);
        setMessage(
          `${updates.length} cell${updates.length === 1 ? "" : "s"} saved${
            saveQueueRef.current.size > 0 ? `, ${saveQueueRef.current.size} still queued` : ""
          }.`
        );

        if (saveQueueRef.current.size > 0) {
          scheduleQueuedSave(100);
        }

        return true;
      } catch (saveError) {
        for (const update of updates) {
          const key = getCellKey(update.rowIndex, update.columnKey);

          if (!saveQueueRef.current.has(key)) {
            saveQueueRef.current.set(key, update);
          }
        }

        saveInFlightRef.current = false;
        setIsSavingCells(false);
        setPendingSaveCount(saveQueueRef.current.size);
        setMessage(null);
        setError(saveError instanceof Error ? saveError.message : "Unable to save queued changes.");
        scheduleQueuedSave(2000);
        return false;
      }
    }

    for (const update of updates) {
      const key = getCellKey(update.rowIndex, update.columnKey);
      inFlightUpdatesRef.current.set(key, update);
    }

    if (!socketUpdateCellsRef.current(updates)) {
      for (const update of updates) {
        const key = getCellKey(update.rowIndex, update.columnKey);
        inFlightUpdatesRef.current.delete(key);
        saveQueueRef.current.set(key, update);
      }

      saveInFlightRef.current = false;
      setIsSavingCells(false);
      setPendingSaveCount(saveQueueRef.current.size);
      setMessage(null);
      setError("Some changes could not be sent yet. They are still queued.");
      scheduleQueuedSave();
      return false;
    }

    setPendingSaveCount(saveQueueRef.current.size);

    setMessage(
      `${updates.length} cell${updates.length === 1 ? "" : "s"} sent to live sync${
        saveQueueRef.current.size > 0 ? `, ${saveQueueRef.current.size} still queued` : ""
      }.`
    );
    scheduleInFlightTimeout();
    return true;
  }, [
    applyCommittedRows,
    applyServerSnapshot,
    clearAutosaveTimer,
    demoMode,
    scheduleInFlightTimeout,
    scheduleQueuedSave
  ]);

  useEffect(() => {
    flushQueuedCellUpdatesRef.current = flushQueuedCellUpdates;
  }, [flushQueuedCellUpdates]);

  const queueCellUpdates = useCallback((
    updates: CellUpdateDraft[],
    label: string,
    delayMs = CELL_AUTOSAVE_DEBOUNCE_MS
  ): void => {
    if (updates.length === 0) {
      return;
    }

    for (const update of updates) {
      saveQueueRef.current.set(getCellKey(update.rowIndex, update.columnKey), update);
    }

    const queuedCount = saveQueueRef.current.size;
    setPendingSaveCount(queuedCount);
    setError(null);
    setMessage(`${label} Save queued for ${queuedCount} cell${queuedCount === 1 ? "" : "s"}.`);

    if (queuedCount >= AUTOSAVE_MAX_BATCH_SIZE && !saveInFlightRef.current) {
      void flushQueuedCellUpdates();
      return;
    }

    scheduleQueuedSave(delayMs);
  }, [flushQueuedCellUpdates, scheduleQueuedSave]);

  const recordCellEditHistory = useCallback((
    previousRows: SheetGridRow[],
    updates: CellUpdateDraft[]
  ): void => {
    const historyEntry = createCellEditHistoryEntry(previousRows, updates);

    if (!historyEntry) {
      return;
    }

    undoStackRef.current = [
      ...undoStackRef.current.slice(-(MAX_CELL_HISTORY_ENTRIES - 1)),
      historyEntry
    ];
    redoStackRef.current = [];
  }, []);

  const applyHistoryUpdates = useCallback(async (
    updates: CellUpdateDraft[],
    label: string
  ): Promise<void> => {
    const currentRows = rowsRef.current;
    const rowsByNumber = new Map(currentRows.map((row) => [row.rowNumber, row]));
    const filteredUpdates = updates.filter((update) => {
      const row = rowsByNumber.get(update.rowIndex);

      return Boolean(
        row &&
          row.__editable[update.columnKey] &&
          getRawCellValue(row, update.columnKey) !== update.value &&
          !isCellLockedByOther(
            locks,
            update.rowIndex,
            update.columnKey,
            latestSnapshotRef.current.currentUser.id
          )
      );
    });

    if (filteredUpdates.length === 0) {
      setError(null);
      setMessage(`${label} skipped because the affected cells are locked or unchanged.`);
      return;
    }

    const nextRows = applyUpdatesToRows(currentRows, filteredUpdates);
    let nextSnapshot = latestSnapshotRef.current;

    rowsRef.current = nextRows;
    setRows(nextRows);
    setError(null);
    setMessage(`${label}...`);

    if (demoMode) {
      const { applyDemoCellUpdate } = await loadDemoEngine();

      for (const update of filteredUpdates) {
        const result = applyDemoCellUpdate(
          nextSnapshot,
          update.rowIndex,
          update.columnKey,
          update.value
        );

        if (!result.snapshot) {
          setRows(currentRows);
          rowsRef.current = currentRows;
          setError(`${update.columnKey}${update.rowIndex}: ${result.error ?? `${label} failed.`}`);
          return;
        }

        nextSnapshot = result.snapshot;
      }

      latestSnapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setRows(nextSnapshot.rows);
      rowsRef.current = nextSnapshot.rows;
      setMessage(`${label} complete.`);
      return;
    }

    queueCellUpdates(filteredUpdates, `${label}.`, BULK_AUTOSAVE_DEBOUNCE_MS);
  }, [demoMode, locks, queueCellUpdates]);

  const undoLastCellEdit = useCallback((): void => {
    const historyEntry = undoStackRef.current.pop();

    if (!historyEntry) {
      setError(null);
      setMessage("Nothing to undo.");
      return;
    }

    redoStackRef.current = [
      ...redoStackRef.current.slice(-(MAX_CELL_HISTORY_ENTRIES - 1)),
      historyEntry
    ];

    startTransition(() => {
      void applyHistoryUpdates(historyEntry.undo, "Undo");
    });
  }, [applyHistoryUpdates, startTransition]);

  const redoLastCellEdit = useCallback((): void => {
    const historyEntry = redoStackRef.current.pop();

    if (!historyEntry) {
      setError(null);
      setMessage("Nothing to redo.");
      return;
    }

    undoStackRef.current = [
      ...undoStackRef.current.slice(-(MAX_CELL_HISTORY_ENTRIES - 1)),
      historyEntry
    ];

    startTransition(() => {
      void applyHistoryUpdates(historyEntry.redo, "Redo");
    });
  }, [applyHistoryUpdates, startTransition]);

  const selectAllCells = useCallback((): void => {
    const columns = latestSnapshotRef.current.columns;
    const currentRows = rowsRef.current;
    const firstRowIndex = currentRows[0]?.rowNumber ?? 1;
    const lastRowIndex = currentRows[currentRows.length - 1]?.rowNumber ?? MAX_ROWS;
    const firstColumnKey = columns[0];
    const lastColumnKey = columns[columns.length - 1];

    if (!firstColumnKey || !lastColumnKey) {
      return;
    }

    const anchor = {
      rowIndex: firstRowIndex,
      columnKey: firstColumnKey
    };
    const focus = {
      rowIndex: lastRowIndex,
      columnKey: lastColumnKey
    };
    const range = { anchor, focus };

    isRangeSelectingRef.current = false;
    selectionKeyboardActiveRef.current = true;
    selectedCellRef.current = anchor;
    selectedRangeRef.current = range;
    setIsRangeSelecting(false);
    stopSelectionAutoScroll();
    setSelectedCell(anchor);
    setSelectedRange(range);
    setError(null);
    setMessage(`Selected ${firstColumnKey}${firstRowIndex}:${lastColumnKey}${lastRowIndex}.`);
  }, [stopSelectionAutoScroll]);

  const applySocketRows = useCallback((incomingRows: SheetGridRow[]): void => {
    applyCommittedRows(incomingRows);
  }, [applyCommittedRows]);

  const finishInFlightUpdate = useCallback((rowIndex: number, columnKey: ColumnKey): void => {
    inFlightUpdatesRef.current.delete(getCellKey(rowIndex, columnKey));

    if (inFlightUpdatesRef.current.size === 0) {
      clearInFlightTimeout();
      saveInFlightRef.current = false;
      setIsSavingCells(false);

      if (saveQueueRef.current.size > 0) {
        scheduleQueuedSave(100);
      }
    }
  }, [clearInFlightTimeout, scheduleQueuedSave]);

  const finishInFlightUpdates = useCallback((
    updates: Array<{ row: number; col: ColumnKey }>
  ): void => {
    for (const update of updates) {
      inFlightUpdatesRef.current.delete(getCellKey(update.row, update.col));
    }

    if (inFlightUpdatesRef.current.size === 0) {
      clearInFlightTimeout();
      saveInFlightRef.current = false;
      setIsSavingCells(false);

      if (saveQueueRef.current.size > 0) {
        scheduleQueuedSave(100);
      }
    }
  }, [clearInFlightTimeout, scheduleQueuedSave]);

  const restoreCommittedRowsWithOptimisticEdits = useCallback((): void => {
    const optimisticUpdates = [
      ...inFlightUpdatesRef.current.values(),
      ...saveQueueRef.current.values()
    ];
    const visibleRows =
      optimisticUpdates.length > 0
        ? applyUpdatesToRows(latestSnapshotRef.current.rows, optimisticUpdates)
        : latestSnapshotRef.current.rows;

    setRows(visibleRows);
    rowsRef.current = visibleRows;
  }, []);

  const refreshLatestSnapshot = useCallback(async (): Promise<void> => {
    if (demoMode) {
      return;
    }

    try {
      const sheetId = latestSnapshotRef.current.sheet.id;
      const response = await fetch(`/api/sheets/${encodeURIComponent(sheetId)}/snapshot`, {
        cache: "no-store"
      });
      const body = (await response.json().catch(() => null)) as {
        snapshot?: SheetSnapshot;
        error?: string;
      } | null;

      if (!response.ok || !body?.snapshot) {
        throw new Error(body?.error ?? "Unable to refresh the latest sheet.");
      }

      applyServerSnapshot(body.snapshot);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Unable to refresh the latest sheet."
      );
    }
  }, [applyServerSnapshot, demoMode]);

  const scheduleSnapshotRefresh = useCallback((): void => {
    if (snapshotRefreshTimerRef.current) {
      clearTimeout(snapshotRefreshTimerRef.current);
    }

    snapshotRefreshTimerRef.current = setTimeout(() => {
      snapshotRefreshTimerRef.current = null;
      void refreshLatestSnapshot();
    }, REALTIME_SNAPSHOT_REFRESH_MS);
  }, [refreshLatestSnapshot]);

  const handleSocketCellChanged = useCallback((payload: CellChangedPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    if (payload.userId === latestSnapshotRef.current.currentUser.id) {
      finishInFlightUpdate(payload.row, payload.col);
    }

    if (payload.rows) {
      applySocketRows(payload.rows);
    } else {
      const nextRows = applyUpdatesToRows(rowsRef.current, [
        {
          rowIndex: payload.row,
          columnKey: payload.col,
          value: payload.value
        }
      ]);

      setRows(nextRows);
      rowsRef.current = nextRows;
    }

    setError(null);
    setMessage(
      payload.userId === latestSnapshotRef.current.currentUser.id
        ? `${payload.col}${payload.row} synced.`
        : `${payload.col}${payload.row} updated live.`
    );
  }, [applySocketRows, finishInFlightUpdate]);

  const handleSocketCellsChanged = useCallback((payload: CellsChangedPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    if (payload.userId === latestSnapshotRef.current.currentUser.id) {
      finishInFlightUpdates(payload.updates);
    }

    if (payload.rows) {
      applySocketRows(payload.rows);
    } else {
      const nextRows = applyUpdatesToRows(
        rowsRef.current,
        payload.updates.map((update) => ({
          rowIndex: update.row,
          columnKey: update.col,
          value: update.value
        }))
      );

      setRows(nextRows);
      rowsRef.current = nextRows;
    }

    setError(null);
    setMessage(
      payload.userId === latestSnapshotRef.current.currentUser.id
        ? payload.persisted === false
          ? `${payload.updates.length} cells sent to live sync.`
          : `${payload.updates.length} cells saved.`
        : payload.persisted === true
          ? `${payload.updates.length} live cells saved.`
          : `${payload.updates.length} cells updated live.`
    );
  }, [applySocketRows, finishInFlightUpdates]);

  const handleSocketRowClaimed = useCallback((payload: RowClaimedPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    applySocketRows(payload.rows);
    setError(null);
    setMessage(
      payload.userId === latestSnapshotRef.current.currentUser.id
        ? `Row ${payload.row} claimed.`
        : `Row ${payload.row} was claimed by another member.`
    );
  }, [applySocketRows]);

  const handleSocketCellError = useCallback((payload: CellErrorPayload): void => {
    if (payload.sheetId && payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    if (payload.row && payload.col) {
      finishInFlightUpdate(payload.row, payload.col);
    } else {
      for (const [key, update] of inFlightUpdatesRef.current.entries()) {
        if (!saveQueueRef.current.has(key)) {
          saveQueueRef.current.set(key, update);
        }
      }

      inFlightUpdatesRef.current.clear();
      clearInFlightTimeout();
      saveInFlightRef.current = false;
      setIsSavingCells(false);
      setPendingSaveCount(saveQueueRef.current.size);
      scheduleQueuedSave();
    }

    restoreCommittedRowsWithOptimisticEdits();
    scheduleSnapshotRefresh();
    setMessage(null);
    setError(payload.message);
  }, [
    clearInFlightTimeout,
    finishInFlightUpdate,
    restoreCommittedRowsWithOptimisticEdits,
    scheduleQueuedSave,
    scheduleSnapshotRefresh
  ]);

  const handleSocketCellLocked = useCallback((payload: CellLockedPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    setLocks((currentLocks) => {
      const nextLocks = new Map(currentLocks);
      nextLocks.set(getCellLockMapKey(payload.row, payload.col), {
        userId: payload.userId,
        userColor: payload.userColor
      });
      return nextLocks;
    });
  }, []);

  const handleSocketCellUnlocked = useCallback((payload: CellUnlockedPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    setLocks((currentLocks) => {
      const nextLocks = new Map(currentLocks);
      nextLocks.delete(getCellLockMapKey(payload.row, payload.col));
      return nextLocks;
    });
  }, []);

  const handleSocketSheetLocks = useCallback((payload: SheetLocksPayload): void => {
    if (payload.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    setLocks(() => {
      const nextLocks = new Map<string, CellLockState>();

      for (const lock of payload.locks) {
        nextLocks.set(getCellLockMapKey(lock.row, lock.col), {
          userId: lock.userId,
          userColor: lock.userColor
        });
      }

      return nextLocks;
    });
  }, []);

  const handleFirestoreRealtimeEvent = useCallback((event: SheetRealtimeEvent): void => {
    if (event.sheetId !== latestSnapshotRef.current.sheet.id) {
      return;
    }

    if (event.sourceClientId === clientInstanceIdRef.current) {
      return;
    }

    if (event.rows?.length) {
      applySocketRows(event.rows);
    }

    if (event.requiresRefresh || !event.rows?.length) {
      scheduleSnapshotRefresh();
    }

    const actorName =
      event.actorId === latestSnapshotRef.current.currentUser.id
        ? "You"
        : event.actorName ?? "Another user";
    const changedCount = event.cellCount ?? event.updates?.length ?? event.rowIndexes?.length ?? 0;
    const label = changedCount === 1 ? "1 cell" : `${changedCount || "Sheet"} cells`;

    setError(null);
    setMessage(
      event.type === "row-claimed"
        ? `${actorName} claimed row ${event.rowIndexes?.[0] ?? ""}.`
        : event.type === "row-unlocked"
          ? `${actorName} unlocked row ${event.rowIndexes?.[0] ?? ""}.`
          : event.type === "format-changed"
            ? `${actorName} updated formatting.`
            : `${label} updated in realtime.`
    );
  }, [applySocketRows, scheduleSnapshotRefresh]);

  const sheetSocket = useSheet({
    sheetId: snapshot.sheet.id,
    enabled: socketSyncEnabled,
    onCellChanged: handleSocketCellChanged,
    onCellsChanged: handleSocketCellsChanged,
    onRowClaimed: handleSocketRowClaimed,
    onCellLocked: handleSocketCellLocked,
    onCellUnlocked: handleSocketCellUnlocked,
    onSheetLocks: handleSocketSheetLocks,
    onCellError: handleSocketCellError
  });
  const {
    connected: socketConnected,
    updateCell: socketUpdateCell,
    updateCells: socketUpdateCells,
    focusCell: socketFocusCell,
    blurCell: socketBlurCell
  } = sheetSocket;
  const sheetRealtime = useSheetRealtime({
    sheetId: snapshot.sheet.id,
    enabled: firestoreSyncEnabled,
    onEvent: handleFirestoreRealtimeEvent,
    onError: setError
  });
  const sheetPresence = useSheetPresence({
    sheetId: snapshot.sheet.id,
    currentUser: snapshot.currentUser,
    enabled: !demoMode && process.env.NEXT_PUBLIC_ENABLE_FIRESTORE_PRESENCE !== "false",
    watch: isAdmin
  });
  const socketLiveConnected = socketSyncEnabled && socketConnected;
  const liveConnected = demoMode || socketLiveConnected || (firestoreSyncEnabled && sheetRealtime.connected);
  const syncBadgeConnected = demoMode || (!socketSyncEnabled && !firestoreSyncEnabled) || liveConnected;
  const syncBadgeLabel = demoMode
    ? "local demo"
    : socketSyncEnabled
      ? liveConnected
        ? "live sync"
        : "connecting"
      : firestoreSyncEnabled
        ? sheetRealtime.connected
          ? "realtime"
          : "realtime connecting"
        : "autosave";
  const activeMembers = useMemo(
    () => sheetPresence.users.filter((user) => user.role === Role.MEMBER),
    [sheetPresence.users]
  );
  const activeMemberNames = useMemo(() => {
    const visibleNames = activeMembers.slice(0, 3).map((user) => user.name);
    const extraCount = activeMembers.length - visibleNames.length;

    return `${visibleNames.join(", ")}${extraCount > 0 ? ` +${extraCount}` : ""}`;
  }, [activeMembers]);
  const activeMembersTitle = sheetPresence.connected
    ? activeMembers.length > 0
      ? `Active members: ${activeMembers.map((user) => user.name).join(", ")}`
      : "No members are active on this sheet."
    : "Active member presence is connecting.";

  useEffect(() => {
    socketConnectedRef.current = socketLiveConnected;
    socketUpdateCellRef.current = (update) => {
      if (!socketLiveConnected) {
        return false;
      }

      socketUpdateCell(update.rowIndex, update.columnKey, update.value);
      return true;
    };
    socketUpdateCellsRef.current = (updates) => {
      if (!socketLiveConnected) {
        return false;
      }

      socketUpdateCells(
        updates.map((update) => ({
          row: update.rowIndex,
          col: update.columnKey,
          value: update.value
        }))
      );
      return true;
    };
    socketFocusCellRef.current = (cell) => {
      if (socketLiveConnected) {
        socketFocusCell(cell.rowIndex, cell.columnKey);
      }
    };
    socketBlurCellRef.current = (cell) => {
      if (socketLiveConnected) {
        socketBlurCell(cell.rowIndex, cell.columnKey);
      }
    };
  }, [socketBlurCell, socketFocusCell, socketLiveConnected, socketUpdateCell, socketUpdateCells]);

  useEffect(() => {
    if (liveConnected && saveQueueRef.current.size > 0) {
      scheduleQueuedSave(100);
    }
  }, [liveConnected, scheduleQueuedSave]);

  useEffect(() => {
    if (!socketSyncEnabled || liveConnected || demoMode || inFlightUpdatesRef.current.size === 0) {
      return;
    }

    for (const [key, update] of inFlightUpdatesRef.current.entries()) {
      if (!saveQueueRef.current.has(key)) {
        saveQueueRef.current.set(key, update);
      }
    }

    inFlightUpdatesRef.current.clear();
    clearInFlightTimeout();
    saveInFlightRef.current = false;
    setIsSavingCells(false);
    setPendingSaveCount(saveQueueRef.current.size);
    restoreCommittedRowsWithOptimisticEdits();
    setError("Live sync disconnected. Changes are queued and will retry when it reconnects.");
  }, [clearInFlightTimeout, demoMode, liveConnected, restoreCommittedRowsWithOptimisticEdits, socketSyncEnabled]);

  const focusLiveCell = useCallback((cell: SelectedCell): void => {
    if (demoMode || !socketSyncEnabled) {
      return;
    }

    const activeCell = activeSocketCellRef.current;

    if (
      activeCell &&
      (activeCell.rowIndex !== cell.rowIndex || activeCell.columnKey !== cell.columnKey)
    ) {
      socketBlurCellRef.current(activeCell);
    }

    activeSocketCellRef.current = cell;
    socketFocusCellRef.current(cell);
  }, [demoMode, socketSyncEnabled]);

  const blurActiveLiveCell = useCallback((): void => {
    const activeCell = activeSocketCellRef.current;

    if (!activeCell || demoMode || !socketSyncEnabled) {
      return;
    }

    socketBlurCellRef.current(activeCell);
    activeSocketCellRef.current = null;
  }, [demoMode, socketSyncEnabled]);

  useEffect(() => {
    return () => {
      blurActiveLiveCell();
    };
  }, [blurActiveLiveCell]);

  async function saveCell(nextRows: SheetGridRow[], data: RowsChangeData<SheetGridRow>) {
    const changedColumn = data.column.key;

    if (!isColumnKey(changedColumn, snapshot.columns)) {
      return;
    }

    const updates: CellUpdateDraft[] = [...new Set(data.indexes)]
      .map((rowIndex) => nextRows[rowIndex])
      .filter((row): row is SheetGridRow => row !== undefined)
      .map((row) => ({
        rowIndex: row.rowNumber,
        columnKey: changedColumn,
        value: String(row[changedColumn] ?? "")
      }))
      .filter(
        (update) =>
          !isCellLockedByOther(
            locks,
            update.rowIndex,
            update.columnKey,
            snapshot.currentUser.id
          )
      );

    const firstUpdate = updates[0];

    if (!firstUpdate) {
      return;
    }

    const previousRows = rows;
    const savedLabel =
      updates.length === 1 ? `${firstUpdate.columnKey}${firstUpdate.rowIndex}` : `${updates.length} cells`;

    setRows(nextRows);
    rowsRef.current = nextRows;
    setError(null);
    setMessage(null);

    if (demoMode) {
      let nextSnapshot = snapshot;
      const { applyDemoCellUpdate } = await loadDemoEngine();

      for (const update of updates) {
        const result = applyDemoCellUpdate(
          nextSnapshot,
          update.rowIndex,
          update.columnKey,
          update.value
        );

        if (!result.snapshot) {
          setRows(previousRows);
          setError(`${update.columnKey}${update.rowIndex}: ${result.error ?? "The cell could not be saved."}`);
          return;
        }

        nextSnapshot = result.snapshot;
      }

      setSnapshot(nextSnapshot);
      setRows(nextSnapshot.rows);
      rowsRef.current = nextSnapshot.rows;
      recordCellEditHistory(previousRows, updates);
      setMessage(`${savedLabel} saved locally.`);
      return;
    }

    recordCellEditHistory(previousRows, updates);
    queueCellUpdates(updates, `${savedLabel} changed.`);
  }

  function handleRowsChange(nextRows: SheetGridRow[], data: RowsChangeData<SheetGridRow>) {
    startTransition(() => {
      void saveCell(nextRows, data);
    });
  }

  const clearSelectedCells = useCallback(async (): Promise<void> => {
    const targetRange = selectedRange ?? (selectedCell ? { anchor: selectedCell, focus: selectedCell } : null);
    const updates = getRangeCellUpdates(rows, snapshot.columns, targetRange, "").filter(
      (update) =>
        !isCellLockedByOther(
          locks,
          update.rowIndex,
          update.columnKey,
          snapshot.currentUser.id
        )
    );

    if (updates.length === 0) {
      setMessage("Selected cells are already empty or locked.");
      setError(null);
      return;
    }

    const previousRows = rows;
    const nextRows = applyUpdatesToRows(rows, updates);
    let nextSnapshot = snapshot;

    setRows(nextRows);
    rowsRef.current = nextRows;
    setError(null);
    setMessage("Clearing...");

    if (demoMode) {
      const { applyDemoCellUpdate } = await loadDemoEngine();

      for (const update of updates) {
        const result = applyDemoCellUpdate(
          nextSnapshot,
          update.rowIndex,
          update.columnKey,
          update.value
        );

        if (!result.snapshot) {
          setRows(previousRows);
          setError(`${update.columnKey}${update.rowIndex}: ${result.error ?? "The cell could not be cleared."}`);
          return;
        }

        nextSnapshot = result.snapshot;
      }

      setSnapshot(nextSnapshot);
      setRows(nextSnapshot.rows);
      rowsRef.current = nextSnapshot.rows;
      recordCellEditHistory(previousRows, updates);
      setMessage(`Cleared ${updates.length} cell${updates.length === 1 ? "" : "s"} locally.`);
      return;
    }

    recordCellEditHistory(previousRows, updates);
    queueCellUpdates(
      updates,
      `Cleared ${updates.length} cell${updates.length === 1 ? "" : "s"}.`,
      BULK_AUTOSAVE_DEBOUNCE_MS
    );
  }, [demoMode, locks, queueCellUpdates, recordCellEditHistory, rows, selectedCell, selectedRange, snapshot]);

  useEffect(() => {
    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (
        event.key === "Escape" &&
        isRangeSelectingRef.current &&
        isSheetInteractionActive(event.target) &&
        !isTextEditingTarget(event.target)
      ) {
        event.preventDefault();
        isRangeSelectingRef.current = false;
        setIsRangeSelecting(false);
        stopSelectionAutoScroll();
        return;
      }

      if (
        event.defaultPrevented ||
        (event.key !== "Backspace" && event.key !== "Delete") ||
        (!selectedCell && !selectedRange) ||
        isTextEditingTarget(event.target)
      ) {
        return;
      }

      if (!isSheetInteractionActive(event.target)) {
        return;
      }

      event.preventDefault();
      startTransition(() => {
        void clearSelectedCells();
      });
    }

    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [
    clearSelectedCells,
    isSheetInteractionActive,
    selectedCell,
    selectedRange,
    startTransition,
    stopSelectionAutoScroll
  ]);

  const applyCellFormat = useCallback(async (
    format: CellFormatPatch = {},
    clear = false
  ): Promise<void> => {
    const targetRange = selectedRange ?? (selectedCell ? { anchor: selectedCell, focus: selectedCell } : null);
    const normalizedRange = getNormalizedCellRange(targetRange, snapshot.columns);

    if (!normalizedRange) {
      setError(null);
      setMessage("Select a cell or row first.");
      return;
    }

    const startColumnKey = snapshot.columns[normalizedRange.startColumnIndex];
    const endColumnKey = snapshot.columns[normalizedRange.endColumnIndex];

    setError(null);
    setMessage(clear ? "Clearing formatting..." : "Formatting...");

    if (demoMode) {
      const { applyDemoCellFormatUpdate } = await loadDemoEngine();
      const result = applyDemoCellFormatUpdate(snapshot, {
        startRow: normalizedRange.startRow,
        endRow: normalizedRange.endRow,
        startColumnKey,
        endColumnKey,
        format,
        clear
      });

      if (!result.snapshot) {
        setError(result.error ?? "Formatting could not be saved.");
        return;
      }

      setSnapshot(result.snapshot);
      setRows(result.snapshot.rows);
      setMessage(clear ? "Formatting cleared locally." : "Formatting saved locally.");
      return;
    }

    const response = await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetId: snapshot.sheet.id,
        startRow: normalizedRange.startRow,
        endRow: normalizedRange.endRow,
        startColumnKey,
        endColumnKey,
        format,
        clear,
        sourceClientId: clientInstanceIdRef.current
      })
    });

    const body = (await response.json()) as {
      snapshot?: SheetSnapshot;
      error?: string;
    };

    if (!response.ok || !body.snapshot) {
      setError(body.error ?? "Formatting could not be saved.");
      return;
    }

    applyServerSnapshot(body.snapshot);
    setMessage(clear ? "Formatting cleared." : "Formatting saved.");
  }, [applyServerSnapshot, demoMode, selectedCell, selectedRange, snapshot]);

  const queueFormatUpdate = useCallback((format: CellFormatPatch = {}, clear = false): void => {
    startTransition(() => {
      void applyCellFormat(format, clear);
    });
  }, [applyCellFormat, startTransition]);

  const updateSelectedColumnRules = useCallback(async (
    patch: Partial<
      Pick<
        NonNullable<typeof selectedColumnPermission>,
        "claimRowOnEdit" | "duplicateHighlight" | "matchHighlightTerms" | "memberWriteOnce"
      >
    >
  ): Promise<void> => {
    if (!selectedAdminColumnKey || !selectedColumnPermission) {
      setError(null);
      setMessage("Select a column first.");
      return;
    }

    if (demoMode) {
      setMessage("Column rules are saved in live mode.");
      return;
    }

    await flushQueuedCellUpdates();
    setError(null);
    setMessage(`Saving rules for column ${selectedAdminColumnKey}...`);

    const response = await fetch("/api/columns/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetId: snapshot.sheet.id,
        columnKey: selectedAdminColumnKey,
        editableByMember: selectedColumnPermission.editableByMember,
        claimRowOnEdit: patch.claimRowOnEdit ?? selectedColumnPermission.claimRowOnEdit,
        memberWriteOnce: patch.memberWriteOnce ?? selectedColumnPermission.memberWriteOnce,
        duplicateHighlight:
          patch.duplicateHighlight ?? selectedColumnPermission.duplicateHighlight,
        matchHighlightTerms:
          patch.matchHighlightTerms ?? selectedColumnPermission.matchHighlightTerms,
        sourceClientId: clientInstanceIdRef.current
      })
    });
    const body = (await response.json().catch(() => null)) as {
      snapshot?: SheetSnapshot;
      error?: string;
    } | null;

    if (!response.ok || !body?.snapshot) {
      setError(body?.error ?? "Column rules could not be saved.");
      return;
    }

    applyServerSnapshot(body.snapshot);
    setMessage(`Column ${selectedAdminColumnKey} rules saved.`);
  }, [
    applyServerSnapshot,
    demoMode,
    flushQueuedCellUpdates,
    selectedAdminColumnKey,
    selectedColumnPermission,
    snapshot.sheet.id
  ]);

  const resetSelectedRow = useCallback(async (): Promise<void> => {
    if (!selectedAdminRowIndex) {
      setError(null);
      setMessage("Select a row first.");
      return;
    }

    if (demoMode) {
      setMessage("Row reset is saved in live mode.");
      return;
    }

    if (!window.confirm(`Reset row ${selectedAdminRowIndex}?`)) {
      return;
    }

    await flushQueuedCellUpdates();
    setError(null);
    setMessage(`Resetting row ${selectedAdminRowIndex}...`);

    const response = await fetch("/api/rows/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetId: snapshot.sheet.id,
        rowIndex: selectedAdminRowIndex,
        sourceClientId: clientInstanceIdRef.current
      })
    });
    const body = (await response.json().catch(() => null)) as {
      snapshot?: SheetSnapshot;
      error?: string;
    } | null;

    if (!response.ok || !body?.snapshot) {
      setError(body?.error ?? "Row could not be reset.");
      return;
    }

    applyServerSnapshot(body.snapshot);
    setMessage(`Row ${selectedAdminRowIndex} reset.`);
  }, [
    applyServerSnapshot,
    demoMode,
    flushQueuedCellUpdates,
    selectedAdminRowIndex,
    snapshot.sheet.id
  ]);

  const unlockAllSheetRows = useCallback(async (): Promise<void> => {
    if (demoMode) {
      setMessage("Unlock all rows is saved in live mode.");
      return;
    }

    if (!window.confirm("Unlock all rows?")) {
      return;
    }

    await flushQueuedCellUpdates();
    setError(null);
    setMessage("Unlocking all rows...");

    const response = await fetch("/api/rows/unlock-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetId: snapshot.sheet.id,
        sourceClientId: clientInstanceIdRef.current
      })
    });
    const body = (await response.json().catch(() => null)) as {
      snapshot?: SheetSnapshot;
      error?: string;
    } | null;

    if (!response.ok || !body?.snapshot) {
      setError(body?.error ?? "Rows could not be unlocked.");
      return;
    }

    applyServerSnapshot(body.snapshot);
    setMessage("All rows unlocked.");
  }, [applyServerSnapshot, demoMode, flushQueuedCellUpdates, snapshot.sheet.id]);

  const openCellHistory = useCallback(async (cell: SelectedCell): Promise<void> => {
    setHistoryPanel({
      cell,
      entries: [],
      loading: true,
      error: null
    });

    if (demoMode) {
      setHistoryPanel({
        cell,
        entries: getDemoCellHistory(snapshot, cell),
        loading: false,
        error: null
      });
      return;
    }

    if (saveQueueRef.current.size > 0 || saveInFlightRef.current) {
      await flushQueuedCellUpdates();
    }

    const params = new URLSearchParams({
      sheetId: latestSnapshotRef.current.sheet.id,
      rowIndex: String(cell.rowIndex),
      columnKey: cell.columnKey
    });
    const response = await fetch(`/api/cells/history?${params.toString()}`);
    const body = (await response.json()) as {
      history?: CellHistoryEntryState[];
      error?: string;
    };

    if (!response.ok || !body.history) {
      setHistoryPanel({
        cell,
        entries: [],
        loading: false,
        error: body.error ?? "Cell history could not be loaded."
      });
      return;
    }

    setHistoryPanel({
      cell,
      entries: body.history,
      loading: false,
      error: null
    });
  }, [demoMode, flushQueuedCellUpdates, snapshot]);

  const updateRangeFocus = useCallback((cell: SelectedCell): void => {
    if (!isAdmin || !isRangeSelectingRef.current) {
      return;
    }

    selectedCellRef.current = cell;
    setSelectedCell(cell);
    setSelectedRange((currentRange) => {
      const nextRange = currentRange
        ? {
            ...currentRange,
            focus: cell
          }
        : { anchor: cell, focus: cell };

      if (
        currentRange &&
        currentRange.focus.rowIndex === cell.rowIndex &&
        currentRange.focus.columnKey === cell.columnKey
      ) {
        return currentRange;
      }

      selectedRangeRef.current = nextRange;
      return nextRange;
    });
  }, [isAdmin]);

  const updateRangeFocusFromPointer = useCallback((
    clientX: number,
    clientY: number,
    rect?: DOMRect
  ): boolean => {
    const cell = getSheetCellFromPoint(
      clientX,
      clientY,
      latestSnapshotRef.current.columns,
      rect
    );

    if (cell) {
      updateRangeFocus(cell);
      return true;
    }

    return false;
  }, [updateRangeFocus]);

  const advanceRangeFocusForAutoScroll = useCallback((velocityX: number, velocityY: number): void => {
    const currentRange = selectedRangeRef.current;
    const currentFocus = currentRange?.focus ?? selectedCellRef.current;
    const columns = latestSnapshotRef.current.columns;

    if (!currentFocus || columns.length === 0) {
      return;
    }

    const currentColumnIndex = columns.indexOf(currentFocus.columnKey);

    if (currentColumnIndex < 0) {
      return;
    }

    const currentRows = rowsRef.current;
    const maxRowIndex = currentRows[currentRows.length - 1]?.rowNumber ?? MAX_ROWS;
    const rowStep =
      velocityY === 0 ? 0 : Math.sign(velocityY) * Math.max(1, Math.ceil(Math.abs(velocityY) / 14));
    const columnStep =
      velocityX === 0 ? 0 : Math.sign(velocityX) * Math.max(1, Math.ceil(Math.abs(velocityX) / 18));
    const nextRowIndex = clampNumber(currentFocus.rowIndex + rowStep, 1, maxRowIndex);
    const nextColumnIndex = clampNumber(currentColumnIndex + columnStep, 0, columns.length - 1);
    const nextCell = {
      rowIndex: nextRowIndex,
      columnKey: columns[nextColumnIndex]
    };

    if (
      nextCell.rowIndex !== currentFocus.rowIndex ||
      nextCell.columnKey !== currentFocus.columnKey
    ) {
      updateRangeFocus(nextCell);
    }
  }, [updateRangeFocus]);

  useEffect(() => {
    runSelectionAutoScrollRef.current = () => {
      const autoScrollState = selectionAutoScrollRef.current;

      if (autoScrollState.velocityX === 0 && autoScrollState.velocityY === 0) {
        autoScrollState.frameId = null;
        return;
      }

      const scrollElement = getGridScrollElement();

      if (scrollElement) {
        const previousScrollLeft = scrollElement.scrollLeft;
        const previousScrollTop = scrollElement.scrollTop;

        scrollElement.scrollBy({
          left: autoScrollState.velocityX,
          top: autoScrollState.velocityY
        });

        if (
          scrollElement.scrollLeft !== previousScrollLeft ||
          scrollElement.scrollTop !== previousScrollTop
        ) {
          const pointerUpdatedRange = updateRangeFocusFromPointer(
            autoScrollState.pointerX,
            autoScrollState.pointerY,
            scrollElement.getBoundingClientRect()
          );

          if (!pointerUpdatedRange) {
            advanceRangeFocusForAutoScroll(
              autoScrollState.velocityX,
              autoScrollState.velocityY
            );
          }
        }
      }

      autoScrollState.frameId = window.requestAnimationFrame(runSelectionAutoScrollRef.current);
    };
  }, [advanceRangeFocusForAutoScroll, getGridScrollElement, updateRangeFocusFromPointer]);

  const updateSelectionAutoScrollAtPoint = useCallback((clientX: number, clientY: number): void => {
    if (!isRangeSelectingRef.current) {
      stopSelectionAutoScroll();
      return;
    }

    const scrollElement = getGridScrollElement();

    if (!scrollElement) {
      stopSelectionAutoScroll();
      return;
    }

    const autoScrollState = selectionAutoScrollRef.current;
    const { velocityX, velocityY } = getSelectionAutoScrollVelocity(
      clientX,
      clientY,
      scrollElement.getBoundingClientRect()
    );

    autoScrollState.pointerX = clientX;
    autoScrollState.pointerY = clientY;
    autoScrollState.velocityX = velocityX;
    autoScrollState.velocityY = velocityY;

    if (velocityX === 0 && velocityY === 0) {
      stopSelectionAutoScroll();
      return;
    }

    if (autoScrollState.frameId === null) {
      autoScrollState.frameId = window.requestAnimationFrame(runSelectionAutoScrollRef.current);
    }
  }, [getGridScrollElement, stopSelectionAutoScroll]);

  const updateSelectionAutoScroll = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    updateSelectionAutoScrollAtPoint(event.clientX, event.clientY);
  }, [updateSelectionAutoScrollAtPoint]);

  useEffect(() => {
    if (!isRangeSelecting) {
      return;
    }

    function updateWindowSelectionAutoScroll(event: MouseEvent): void {
      updateSelectionAutoScrollAtPoint(event.clientX, event.clientY);
    }

    window.addEventListener("mousemove", updateWindowSelectionAutoScroll);

    return () => {
      window.removeEventListener("mousemove", updateWindowSelectionAutoScroll);
    };
  }, [isRangeSelecting, updateSelectionAutoScrollAtPoint]);

  const handleFill = useCallback((event: FillEvent<SheetGridRow>): SheetGridRow => {
    if (!isColumnKey(event.columnKey, snapshot.columns)) {
      return event.targetRow;
    }

    if (!event.sourceRow.__editable[event.columnKey] || !event.targetRow.__editable[event.columnKey]) {
      return event.targetRow;
    }

    if (
      isCellLockedByOther(
        locks,
        event.sourceRow.rowNumber,
        event.columnKey,
        snapshot.currentUser.id
      ) ||
      isCellLockedByOther(
        locks,
        event.targetRow.rowNumber,
        event.columnKey,
        snapshot.currentUser.id
      )
    ) {
      return event.targetRow;
    }

    const sourceValue = getRawCellValue(event.sourceRow, event.columnKey);

    if (sourceValue === getRawCellValue(event.targetRow, event.columnKey)) {
      return event.targetRow;
    }

    return {
      ...event.targetRow,
      [event.columnKey]: sourceValue
    };
  }, [locks, snapshot.columns, snapshot.currentUser.id]);

  const renderers = useMemo<Renderers<SheetGridRow, unknown>>(() => ({
    renderRow(
      key: React.Key,
      props: RenderRowProps<SheetGridRow, unknown>
    ): React.ReactNode {
      const backgroundColor = getAlternateRowBackground(props.row, snapshot.viewSetting);
      const color = getReadableTextColorForBackground(backgroundColor);
      const rowStyle =
        backgroundColor || color
          ? ({
              ...props.style,
              ...(backgroundColor ? { "--sheet-row-bg": backgroundColor } : {}),
              ...(color ? { "--sheet-row-color": color } : {})
            } as CSSProperties)
          : props.style;

      return (
        <Row
          key={key}
          {...props}
          style={rowStyle}
        />
      );
    },
    renderCell(
      key: React.Key,
      props: CellRendererProps<SheetGridRow, unknown>
    ): React.ReactNode {
      const columnKey = props.column.key;

      if (columnKey === "rowNumber") {
        const lastColumnKey = snapshot.columns[snapshot.columns.length - 1];
        const cell = {
          rowIndex: props.row.rowNumber,
          columnKey: lastColumnKey
        };

        return (
          <Cell
            key={key}
            {...props}
            data-sheet-row-index={props.row.rowNumber}
            data-sheet-column-key={lastColumnKey}
            onMouseEnter={(event) => {
              props.onMouseEnter?.(event);
              updateRangeFocus(cell);
            }}
            onMouseMove={(event) => {
              props.onMouseMove?.(event);
              updateRangeFocus(cell);
            }}
          />
        );
      }

      if (!isColumnKey(columnKey, snapshot.columns)) {
        return <Cell key={key} {...props} />;
      }

      const cell = {
        rowIndex: props.row.rowNumber,
        columnKey
      };
      const format = getCellFormat(props.row, columnKey);

      return (
        <Cell
          key={key}
          {...props}
          data-sheet-row-index={props.row.rowNumber}
          data-sheet-column-key={columnKey}
          style={getCellContainerStyle(props.style, format)}
          onMouseEnter={(event) => {
            props.onMouseEnter?.(event);
            updateRangeFocus(cell);
          }}
          onMouseMove={(event) => {
            props.onMouseMove?.(event);
            updateRangeFocus(cell);
          }}
        />
      );
    }
  }), [snapshot.columns, snapshot.viewSetting, updateRangeFocus]);

  const applyPastedText = useCallback(async (
    startRowIndex: number,
    startColumnKey: ColumnKey,
    clipboardText: string
  ): Promise<void> => {
    const pastedGrid = parseClipboardGrid(clipboardText);

    if (pastedGrid.length === 0 || pastedGrid[0].length === 0) {
      return;
    }

    const startColumnIndex = snapshot.columns.indexOf(startColumnKey);
    let nextSnapshot = snapshot;
    let firstError: string | null = null;
    let appliedCount = 0;
    const appliedUpdates: CellUpdateDraft[] = [];

    setError(null);
    setMessage("Pasting...");

    if (demoMode) {
      const { applyDemoCellUpdate } = await loadDemoEngine();

      for (let rowOffset = 0; rowOffset < pastedGrid.length; rowOffset += 1) {
        const rowIndex = startRowIndex + rowOffset;

        if (rowIndex > MAX_ROWS) {
          break;
        }

        for (let columnOffset = 0; columnOffset < pastedGrid[rowOffset].length; columnOffset += 1) {
          const columnKey = snapshot.columns[startColumnIndex + columnOffset];

          if (!columnKey) {
            break;
          }

          const result = applyDemoCellUpdate(
            nextSnapshot,
            rowIndex,
            columnKey,
            pastedGrid[rowOffset][columnOffset]
          );

          if (!result.snapshot) {
            firstError = `${columnKey}${rowIndex}: ${result.error ?? "Could not paste value."}`;
            break;
          }

          nextSnapshot = result.snapshot;
          appliedUpdates.push({
            rowIndex,
            columnKey,
            value: pastedGrid[rowOffset][columnOffset]
          });
          appliedCount += 1;
        }

        if (firstError) {
          break;
        }
      }
    } else {
      const updates: CellUpdateDraft[] = [];

      for (let rowOffset = 0; rowOffset < pastedGrid.length; rowOffset += 1) {
        const rowIndex = startRowIndex + rowOffset;
        const row = rows.find((item) => item.rowNumber === rowIndex);

        if (rowIndex > MAX_ROWS) {
          break;
        }

        for (let columnOffset = 0; columnOffset < pastedGrid[rowOffset].length; columnOffset += 1) {
          const columnKey = snapshot.columns[startColumnIndex + columnOffset];

          if (!columnKey) {
            break;
          }

          if (
            row &&
            (!row.__editable[columnKey] ||
              isCellLockedByOther(locks, rowIndex, columnKey, snapshot.currentUser.id))
          ) {
            continue;
          }

          updates.push({
            rowIndex,
            columnKey,
            value: pastedGrid[rowOffset][columnOffset]
          });
        }
      }

      if (updates.length > 0) {
        const previousRows = rows;
        const nextRows = applyUpdatesToRows(rows, updates);

        setRows(nextRows);
        rowsRef.current = nextRows;
        recordCellEditHistory(previousRows, updates);
        queueCellUpdates(
          updates,
          `Pasted ${updates.length} cell${updates.length === 1 ? "" : "s"}.`,
          BULK_AUTOSAVE_DEBOUNCE_MS
        );
        return;
      }
    }

    if (appliedCount > 0) {
      setSnapshot(nextSnapshot);
      setRows(nextSnapshot.rows);
      rowsRef.current = nextSnapshot.rows;
      recordCellEditHistory(rows, appliedUpdates);
      setMessage(`Pasted ${appliedCount} cell${appliedCount === 1 ? "" : "s"}.`);
    }

    if (firstError) {
      setError(firstError);
    } else {
      setError(null);
    }
  }, [demoMode, locks, queueCellUpdates, recordCellEditHistory, rows, snapshot]);

  useEffect(() => {
    function handleSpreadsheetShortcut(event: KeyboardEvent): void {
      const shortcutKey = event.key.toLowerCase();
      const hasModifier = event.ctrlKey || event.metaKey;

      if (
        event.defaultPrevented ||
        !hasModifier ||
        isTextEditingTarget(event.target) ||
        !isSheetInteractionActive(event.target)
      ) {
        return;
      }

      if (shortcutKey === "a") {
        event.preventDefault();
        selectAllCells();
        return;
      }

      if (shortcutKey === "z") {
        event.preventDefault();

        if (event.shiftKey) {
          redoLastCellEdit();
        } else {
          undoLastCellEdit();
        }

        return;
      }

      if (shortcutKey === "y") {
        event.preventDefault();
        redoLastCellEdit();
        return;
      }

      if (!isAdmin) {
        return;
      }

      if (shortcutKey === "b") {
        event.preventDefault();
        queueFormatUpdate({ bold: !selectedFormat.bold });
        return;
      }

      if (shortcutKey === "i") {
        event.preventDefault();
        queueFormatUpdate({ italic: !selectedFormat.italic });
        return;
      }

      if (shortcutKey === "u") {
        event.preventDefault();
        queueFormatUpdate({ underline: !selectedFormat.underline });
      }
    }

    document.addEventListener("keydown", handleSpreadsheetShortcut);

    return () => {
      document.removeEventListener("keydown", handleSpreadsheetShortcut);
    };
  }, [
    isAdmin,
    isSheetInteractionActive,
    queueFormatUpdate,
    redoLastCellEdit,
    selectAllCells,
    selectedFormat.bold,
    selectedFormat.italic,
    selectedFormat.underline,
    undoLastCellEdit
  ]);

  useEffect(() => {
    function shouldHandleClipboardEvent(event: ClipboardEvent): boolean {
      return (
        !event.defaultPrevented &&
        !isTextEditingTarget(event.target) &&
        isSheetInteractionActive(event.target) &&
        Boolean(selectedCellRef.current || selectedRangeRef.current)
      );
    }

    function handleDocumentCopy(event: ClipboardEvent): void {
      if (!shouldHandleClipboardEvent(event) || !selectedClipboardValue) {
        return;
      }

      event.clipboardData?.setData("text/plain", selectedClipboardValue);
      event.preventDefault();
      setError(null);
      setMessage("Copied selection.");
    }

    function handleDocumentCut(event: ClipboardEvent): void {
      if (!shouldHandleClipboardEvent(event) || !selectedClipboardValue) {
        return;
      }

      event.clipboardData?.setData("text/plain", selectedClipboardValue);
      event.preventDefault();
      startTransition(() => {
        void clearSelectedCells();
      });
    }

    function handleDocumentPaste(event: ClipboardEvent): void {
      if (!shouldHandleClipboardEvent(event)) {
        return;
      }

      const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
      const pasteStartCell =
        getRangeStartCell(selectedRangeRef.current, latestSnapshotRef.current.columns) ??
        selectedCellRef.current;

      if (!clipboardText || !pasteStartCell) {
        return;
      }

      event.preventDefault();
      startTransition(() => {
        void applyPastedText(pasteStartCell.rowIndex, pasteStartCell.columnKey, clipboardText);
      });
    }

    document.addEventListener("copy", handleDocumentCopy);
    document.addEventListener("cut", handleDocumentCut);
    document.addEventListener("paste", handleDocumentPaste);

    return () => {
      document.removeEventListener("copy", handleDocumentCopy);
      document.removeEventListener("cut", handleDocumentCut);
      document.removeEventListener("paste", handleDocumentPaste);
    };
  }, [
    applyPastedText,
    clearSelectedCells,
    isSheetInteractionActive,
    selectedClipboardValue,
    startTransition
  ]);

  function handleSelectedCellPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const pasteStartCell = getRangeStartCell(selectedRange, snapshot.columns) ?? selectedCell;

    if (!pasteStartCell) {
      return;
    }
    const clipboardText = event.clipboardData.getData("text/plain");

    if (!clipboardText) {
      return;
    }

    event.preventDefault();
    startTransition(() => {
      void applyPastedText(pasteStartCell.rowIndex, pasteStartCell.columnKey, clipboardText);
    });
  }

  const SpreadsheetTextEditor = useCallback(function SpreadsheetTextEditor({
    row,
    column,
    onRowChange,
    onClose
  }: RenderEditCellProps<SheetGridRow>) {
    const columnKey = column.key;
    const value = isColumnKey(columnKey, snapshot.columns) ? String(row[columnKey] ?? "") : "";

    return (
      <input
        autoFocus
        className="h-full w-full border-0 bg-[color:var(--panel)] px-2 text-sm text-[color:var(--text)] outline-none"
        value={value}
        onBlur={() => onClose(true)}
        onChange={(event) => {
          if (isColumnKey(columnKey, snapshot.columns)) {
            onRowChange({ ...row, [columnKey]: event.target.value });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onClose(true);
          }

          if (event.key === "Escape") {
            onClose(false);
          }
        }}
        onPaste={(event) => {
          if (!isColumnKey(columnKey, snapshot.columns)) {
            return;
          }

          const clipboardText = event.clipboardData.getData("text/plain");

          if (!clipboardText.includes("\t") && !clipboardText.includes("\n") && !clipboardText.includes("\r")) {
            return;
          }

          event.preventDefault();
          onClose(false);
          startTransition(() => {
            void applyPastedText(row.rowNumber, columnKey, clipboardText);
          });
        }}
      />
    );
  }, [applyPastedText, snapshot.columns, startTransition]);

  const columns = useMemo<Column<SheetGridRow>[]>(() => {
    const rowColumn: Column<SheetGridRow> = {
      key: "rowNumber",
      name: "#",
      frozen: true,
      width: 64,
      minWidth: 64,
      renderCell: ({ row }) => (
        <div className="sheet-row-index text-right text-xs">{row.rowNumber}</div>
      )
    };

    return [
      rowColumn,
      ...snapshot.columns.map(
        (columnKey): Column<SheetGridRow> => ({
          key: columnKey,
          name: columnKey,
          width: DEFAULT_DATA_COLUMN_WIDTH,
          minWidth: 1,
          resizable: true,
          editable: (row: SheetGridRow) =>
            row.__editable[columnKey] &&
            !isCellLockedByOther(
              locks,
              row.rowNumber,
              columnKey,
              snapshot.currentUser.id
            ),
          renderEditCell: SpreadsheetTextEditor,
          cellClass: (row: SheetGridRow) => {
            const lockedByOther = isCellLockedByOther(
              locks,
              row.rowNumber,
              columnKey,
              snapshot.currentUser.id
            );

            return clsx(
              "sheet-cell",
              (!row.__editable[columnKey] || lockedByOther) && "sheet-cell-locked",
              lockedByOther && "sheet-cell-live-locked",
              row.ownerId && "sheet-cell-owned",
              row.__formula[columnKey] && "sheet-cell-formula",
              isCellInsideRange(row.rowNumber, columnKey, selectedRange, snapshot.columns) &&
                "sheet-cell-range-selected",
              selectedRange?.anchor.rowIndex === row.rowNumber &&
                selectedRange.anchor.columnKey === columnKey &&
                "sheet-cell-range-anchor"
            );
          },
          renderCell: ({ row }) => {
            const lock = locks.get(getCellLockMapKey(row.rowNumber, columnKey));
            const lockedByOther = lock && lock.userId !== snapshot.currentUser.id;
            const renderedValue = getRenderedCellValue(row, columnKey);

            return (
              <div
                className="sheet-cell-content"
                style={{
                  ...getCellTextStyle(getCellFormat(row, columnKey)),
                  ...(lockedByOther ? { "--sheet-lock-color": lock.userColor } : {})
                } as CSSProperties}
                title={row.__formula[columnKey] ? row[columnKey] : undefined}
              >
                {lockedByOther ? (
                  <span
                    className="sheet-cell-lock-badge"
                    style={{ backgroundColor: lock.userColor }}
                    title="Editing live"
                  >
                    {getUserInitials(lock.userId)}
                  </span>
                ) : null}
                {renderWrappedCellText(renderedValue)}
              </div>
            );
          }
        })
      )
    ];
  }, [locks, snapshot.columns, snapshot.currentUser.id, SpreadsheetTextEditor, selectedRange]);

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{snapshot.sheet.name}</h1>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-[color:var(--text-muted)]">
            {demoMode ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1">
                local demo
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1">
              <ShieldCheck size={14} />
              {snapshot.currentUser.role === Role.ADMIN ? "admin" : "member"}
            </span>
            {isAdmin ? (
              <span
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1"
                title={activeMembersTitle}
              >
                <UsersRound size={14} />
                <span>
                  {sheetPresence.connected
                    ? `${activeMembers.length} active member${activeMembers.length === 1 ? "" : "s"}`
                    : "members connecting"}
                </span>
                {activeMemberNames ? (
                  <span className="hidden max-w-44 truncate sm:inline">
                    {activeMemberNames}
                  </span>
                ) : null}
                {activeMembers.length > 0 ? (
                  <span className="ml-1 inline-flex -space-x-1">
                    {activeMembers.slice(0, 5).map((user) => (
                      <span
                        key={user.userId}
                        className="grid h-5 w-5 place-items-center rounded-full border border-[color:var(--panel)] text-[9px] font-semibold leading-none text-white"
                        style={{ backgroundColor: user.color }}
                      >
                        {getDisplayInitials(user.name, user.userId)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1">
              <Lock size={14} />
              {countEditableColumns(snapshot)} member columns
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1">
              <Sigma size={14} />
              {snapshot.conditionalRules.filter((rule) => rule.enabled).length} active rules
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-[color:var(--line)] px-2 py-1">
              <span
                className={clsx(
                  "h-2 w-2 rounded-full",
                  syncBadgeConnected ? "bg-teal-500" : "bg-amber-500"
                )}
              />
              {syncBadgeLabel}
            </span>
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-[color:var(--line)] bg-[color:var(--panel-muted)] px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-[color:var(--text-muted)]">
              {selectedAddressLabel}
            </span>
            <span className="truncate">{selectedRawValue || " "}</span>
          </div>
          {selectedComputedValue ? (
            <div className="mt-1 truncate text-xs text-[color:var(--text-muted)]">
              = {selectedComputedValue}
            </div>
          ) : null}
          {selectedLockReason ? (
            <div className="mt-1 truncate text-xs text-[color:var(--danger)]">
              {selectedLockReason}
            </div>
          ) : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-3 shadow-sm xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-9 items-center rounded-md border border-[color:var(--line)] px-2 font-mono text-xs text-[color:var(--text-muted)]">
              {selectedAddressLabel}
            </span>
            <FormatIconButton
              active={selectedFormat.bold}
              title="Bold"
              onClick={() => queueFormatUpdate({ bold: !selectedFormat.bold })}
            >
              <Bold size={16} />
            </FormatIconButton>
            <FormatIconButton
              active={selectedFormat.italic}
              title="Italic"
              onClick={() => queueFormatUpdate({ italic: !selectedFormat.italic })}
            >
              <Italic size={16} />
            </FormatIconButton>
            <FormatIconButton
              active={selectedFormat.underline}
              title="Underline"
              onClick={() => queueFormatUpdate({ underline: !selectedFormat.underline })}
            >
              <Underline size={16} />
            </FormatIconButton>
            {(["left", "center", "right"] as HorizontalAlign[]).map((alignment) => {
              const Icon =
                alignment === "left"
                  ? TextAlignStart
                  : alignment === "center"
                    ? TextAlignCenter
                    : TextAlignEnd;

              return (
                <FormatIconButton
                  active={selectedFormat.horizontalAlign === alignment}
                  key={alignment}
                  title={`Align ${alignment}`}
                  onClick={() =>
                    queueFormatUpdate({
                      horizontalAlign:
                        selectedFormat.horizontalAlign === alignment ? null : alignment
                    })
                  }
                >
                  <Icon size={16} />
                </FormatIconButton>
              );
            })}
            <FormatIconButton
              title="Clear formatting"
              onClick={() => queueFormatUpdate({}, true)}
            >
              <Eraser size={16} />
            </FormatIconButton>
            <ToolbarTextButton
              active={Boolean(selectedColumnPermission?.duplicateHighlight)}
              disabled={!selectedColumnPermission}
              title="Highlight duplicate entries in the selected column"
              onClick={() =>
                startTransition(() => {
                  void updateSelectedColumnRules({
                    duplicateHighlight: !selectedColumnPermission?.duplicateHighlight
                  });
                })
              }
            >
              <PaintBucket size={14} />
              Duplicate {selectedAdminColumnKey ?? "--"}
            </ToolbarTextButton>
            <ToolbarTextButton
              active={Boolean(selectedColumnPermission?.matchHighlightTerms.length)}
              disabled={!selectedColumnPermission}
              title="Check selected column values against pasted terms"
              onClick={() => {
                if (!selectedAdminColumnKey || !selectedColumnPermission) {
                  return;
                }

                setColumnCheckDialog({
                  columnKey: selectedAdminColumnKey,
                  text: selectedColumnPermission.matchHighlightTerms.join("\n")
                });
              }}
            >
              <PaintBucket size={14} />
              Check column {selectedAdminColumnKey ?? "--"}
            </ToolbarTextButton>
            <ToolbarTextButton
              active={Boolean(selectedColumnPermission?.claimRowOnEdit)}
              disabled={!selectedColumnPermission}
              title="Members who save a valid value in this selected column will own that row"
              onClick={() =>
                startTransition(() => {
                  void updateSelectedColumnRules({
                    claimRowOnEdit: !selectedColumnPermission?.claimRowOnEdit
                  });
                })
              }
            >
              <LockKeyhole size={14} />
              Claim row {selectedAdminColumnKey ?? "--"}
            </ToolbarTextButton>
            <ToolbarTextButton
              active={Boolean(selectedColumnPermission?.memberWriteOnce)}
              disabled={!selectedColumnPermission}
              title="Members can fill this selected column once; admins can still edit"
              onClick={() =>
                startTransition(() => {
                  void updateSelectedColumnRules({
                    memberWriteOnce: !selectedColumnPermission?.memberWriteOnce
                  });
                })
              }
            >
              <Lock size={14} />
              Write once {selectedAdminColumnKey ?? "--"}
            </ToolbarTextButton>
            <ToolbarTextButton
              disabled={!selectedAdminRowIndex}
              title="Reset selected row"
              onClick={() =>
                startTransition(() => {
                  void resetSelectedRow();
                })
              }
            >
              <Eraser size={14} />
              Reset row {selectedAdminRowIndex ?? "--"}
            </ToolbarTextButton>
            <ToolbarTextButton
              title="Unlock all rows"
              onClick={() =>
                startTransition(() => {
                  void unlockAllSheetRows();
                })
              }
            >
              <Rows3 size={14} />
              Unlock all
            </ToolbarTextButton>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Rows3 size={16} className="text-[color:var(--text-muted)]" />
              <PaintBucket size={16} className="text-[color:var(--text-muted)]" />
              <input
                aria-label="Fill color"
                className="focus-ring h-8 w-10 rounded-md border border-[color:var(--line)] bg-transparent p-1"
                type="color"
                value={fillColor}
                onChange={(event) => setFillColor(event.target.value)}
                onBlur={() => queueFormatUpdate({ backgroundColor: fillColor })}
              />
              <div className="flex flex-wrap items-center gap-1">
                {FORMAT_COLOR_PALETTE.slice(0, 10).map((color) => (
                  <ColorSwatch
                    color={color}
                    key={`fill-${color}`}
                    selected={fillColor === color}
                    title={`Fill ${color}`}
                    onClick={() => {
                      setFillColor(color);
                      queueFormatUpdate({ backgroundColor: color });
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Palette size={16} className="text-[color:var(--text-muted)]" />
              <input
                aria-label="Text color"
                className="focus-ring h-8 w-10 rounded-md border border-[color:var(--line)] bg-transparent p-1"
                type="color"
                value={textColor}
                onChange={(event) => setTextColor(event.target.value)}
                onBlur={() => queueFormatUpdate({ textColor })}
              />
              <div className="flex flex-wrap items-center gap-1">
                {["#111827", "#ffffff", "#be123c", "#b45309", "#0f766e", "#1d4ed8"].map(
                  (color) => (
                    <ColorSwatch
                      color={color}
                      key={`text-${color}`}
                      selected={textColor === color}
                      title={`Text ${color}`}
                      onClick={() => {
                        setTextColor(color);
                        queueFormatUpdate({ textColor: color });
                      }}
                    />
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {(message || error || isPending || pendingSaveCount > 0 || isSavingCells) && (
        <div
          className={clsx(
            "flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm",
            error
              ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200"
              : "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-900/70 dark:bg-teal-950/40 dark:text-teal-100"
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
            <span>{statusMessage}</span>
          </div>
          {pendingSaveCount > 0 && !isSavingCells ? (
            <button
              className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-current px-2 text-xs font-medium transition hover:bg-white/40 dark:hover:bg-white/10"
              type="button"
              onClick={() => {
                void flushQueuedCellUpdates();
              }}
            >
              <Save size={14} />
              Sync now
            </button>
          ) : null}
        </div>
      )}

      <div
        ref={gridShellRef}
        className="overflow-hidden rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] shadow-sm"
        onMouseDownCapture={() => {
          selectionKeyboardActiveRef.current = true;
        }}
        onMouseMove={updateSelectionAutoScroll}
      >
        <textarea
          aria-label="Selected cell clipboard bridge"
          className="sr-only"
          readOnly
          value={selectedClipboardValue}
          onCopy={(event) => {
            if (!selectedClipboardValue) {
              return;
            }

            event.clipboardData.setData("text/plain", selectedClipboardValue);
            event.preventDefault();
          }}
          onPaste={handleSelectedCellPaste}
        />
        <DataGrid
          ref={dataGridRef}
          className={clsx("fill-grid", isRangeSelecting && "sheet-range-selecting")}
          columns={columns}
          columnWidths={columnWidths}
          renderers={renderers}
          rowHeight={rowHeight}
          rows={rows}
          style={
            {
              "--rdg-font-size": `${snapshot.viewSetting.fontSize}px`,
              "--sheet-font-size": `${snapshot.viewSetting.fontSize}px`
            } as CSSProperties
          }
          onColumnWidthsChange={handleColumnWidthsChange}
          onRowsChange={handleRowsChange}
          onFill={isAdmin ? handleFill : undefined}
          onCellMouseDown={(args, event) => {
            selectionKeyboardActiveRef.current = true;

            if (!isAdmin) {
              return;
            }

            if (event.button !== 0) {
              return;
            }

            if (args.column.key === "rowNumber") {
              const anchor = {
                rowIndex: args.row.rowNumber,
                columnKey: snapshot.columns[0]
              };
              const focus = {
                rowIndex: args.row.rowNumber,
                columnKey: snapshot.columns[snapshot.columns.length - 1]
              };
              const range = { anchor, focus };

              selectedCellRef.current = anchor;
              selectedRangeRef.current = range;
              isRangeSelectingRef.current = true;
              setSelectedCell(anchor);
              setSelectedRange(range);
              setIsRangeSelecting(true);
              focusLiveCell(anchor);
              args.selectCell(false);

              event.preventDefault();
              event.preventGridDefault();
              return;
            }

            if (!isColumnKey(args.column.key, snapshot.columns)) {
              return;
            }

            const cell = {
              rowIndex: args.row.rowNumber,
              columnKey: args.column.key
            };
            const range = { anchor: cell, focus: cell };

            selectedCellRef.current = cell;
            selectedRangeRef.current = range;
            isRangeSelectingRef.current = true;
            setSelectedCell(cell);
            setSelectedRange(range);
            setIsRangeSelecting(true);
            focusLiveCell(cell);
            args.selectCell(false);

            event.preventDefault();
            event.preventGridDefault();
          }}
          onCellClick={(args) => {
            args.selectCell(false);
          }}
          onCellDoubleClick={(args, event) => {
            if (
              isColumnKey(args.column.key, snapshot.columns) &&
              args.row.__editable[args.column.key] &&
              !isCellLockedByOther(
                locks,
                args.row.rowNumber,
                args.column.key,
                snapshot.currentUser.id
              )
            ) {
              args.selectCell(true);
            }

            event.preventGridDefault();
          }}
          onCellKeyDown={(args, event) => {
            if (args.mode === "EDIT" || (event.key !== "Backspace" && event.key !== "Delete")) {
              return;
            }

            event.preventDefault();
            event.preventGridDefault();
            startTransition(() => {
              void clearSelectedCells();
            });
          }}
          onCellCopy={(args, event) => {
            if (!isColumnKey(args.column.key, snapshot.columns)) {
              return;
            }

            event.clipboardData.setData(
              "text/plain",
              selectedClipboardValue || getRenderedCellValue(args.row, args.column.key)
            );
            event.preventDefault();
          }}
          onCellPaste={(args, event) => {
            const columnKey = args.column.key;

            if (!isColumnKey(columnKey, snapshot.columns)) {
              return args.row;
            }

            const clipboardText = event.clipboardData.getData("text/plain");
            if (!clipboardText) {
              return args.row;
            }

            event.preventDefault();
            const pasteStartCell = getRangeStartCell(selectedRange, snapshot.columns) ?? {
              rowIndex: args.row.rowNumber,
              columnKey
            };

            startTransition(() => {
              void applyPastedText(pasteStartCell.rowIndex, pasteStartCell.columnKey, clipboardText);
            });

            return args.row;
          }}
          onCellContextMenu={(args, event) => {
            if (!isAdmin || !isColumnKey(args.column.key, snapshot.columns)) {
              return;
            }

            const cell = {
              rowIndex: args.row.rowNumber,
              columnKey: args.column.key
            };

            setIsRangeSelecting(false);
            isRangeSelectingRef.current = false;
            selectedCellRef.current = cell;
            selectedRangeRef.current = { anchor: cell, focus: cell };
            setSelectedCell(cell);
            setSelectedRange({ anchor: cell, focus: cell });
            event.preventDefault();
            event.preventGridDefault();
            void openCellHistory(cell);
          }}
          onSelectedCellChange={(args) => {
            if (args.row && isColumnKey(args.column.key, snapshot.columns)) {
              const cell = {
                rowIndex: args.row.rowNumber,
                columnKey: args.column.key
              };

              selectionKeyboardActiveRef.current = true;
              selectedCellRef.current = cell;
              setSelectedCell(cell);
              focusLiveCell(cell);

              if (!isRangeSelecting) {
                const range = { anchor: cell, focus: cell };

                selectedRangeRef.current = range;
                setSelectedRange(range);
              }
            }
          }}
        />
      </div>

      {historyPanel ? (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-[color:var(--line)] bg-[color:var(--panel)] shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--line)] px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <History size={16} />
                <span>
                  {historyPanel.cell.columnKey}
                  {historyPanel.cell.rowIndex} edit history
                </span>
              </div>
              <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                {historyPanel.entries.length} recorded change
                {historyPanel.entries.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              aria-label="Close history"
              className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--line)] transition hover:bg-[color:var(--panel-muted)]"
              type="button"
              onClick={() => setHistoryPanel(null)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {historyPanel.loading ? (
              <p className="text-sm text-[color:var(--text-muted)]">Loading history...</p>
            ) : historyPanel.error ? (
              <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">
                {historyPanel.error}
              </div>
            ) : historyPanel.entries.length === 0 ? (
              <p className="text-sm text-[color:var(--text-muted)]">
                No edits recorded for this cell.
              </p>
            ) : (
              <div className="space-y-3">
                {historyPanel.entries.map((entry) => {
                  const hasValueChange = entry.previousValue !== null || entry.value !== null;
                  const hasComputedValue =
                    entry.computedValue !== null &&
                    entry.computedValue !== entry.value;

                  return (
                    <article
                      className="rounded-md border border-[color:var(--line)] bg-[color:var(--panel-muted)] p-3 text-sm"
                      key={entry.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {entry.actorName ?? "Unknown user"}
                          </p>
                          <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                            {entry.message}
                          </p>
                        </div>
                        <time className="shrink-0 text-right text-xs text-[color:var(--text-muted)]">
                          {new Date(entry.createdAt).toLocaleString()}
                        </time>
                      </div>

                      {hasValueChange ? (
                        <div className="mt-3 grid gap-2">
                          <div>
                            <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                              Previous
                            </span>
                            <div className="mt-1 min-h-9 rounded-md border border-[color:var(--line)] bg-[color:var(--panel)] px-2 py-1.5 font-mono text-xs">
                              {entry.previousValue || "(blank)"}
                            </div>
                          </div>
                          <div>
                            <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                              New
                            </span>
                            <div className="mt-1 min-h-9 rounded-md border border-[color:var(--line)] bg-[color:var(--panel)] px-2 py-1.5 font-mono text-xs">
                              {entry.value || "(blank)"}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {hasComputedValue ? (
                        <p className="mt-2 text-xs text-[color:var(--text-muted)]">
                          Computed value:{" "}
                          <span className="font-mono">{entry.computedValue}</span>
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {columnCheckDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6">
          <form
            className="w-full max-w-lg rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] p-4 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();

              const terms = parseColumnCheckTerms(columnCheckDialog.text);

              startTransition(() => {
                void updateSelectedColumnRules({ matchHighlightTerms: terms });
              });
              setColumnCheckDialog(null);
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[color:var(--line)] pb-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">
                  Check column {columnCheckDialog.columnKey}
                </h2>
                <p className="mt-1 text-xs text-[color:var(--text-muted)]">
                  {parseColumnCheckTerms(columnCheckDialog.text).length} terms
                </p>
              </div>
              <button
                aria-label="Close column check"
                className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md border border-[color:var(--line)] transition hover:bg-[color:var(--panel-muted)]"
                type="button"
                onClick={() => setColumnCheckDialog(null)}
              >
                <X size={16} />
              </button>
            </div>

            <textarea
              autoFocus
              className="focus-ring mt-4 min-h-40 w-full resize-y rounded-md border border-[color:var(--line)] bg-[color:var(--panel-muted)] px-3 py-2 text-sm text-[color:var(--text)] outline-none"
              value={columnCheckDialog.text}
              onChange={(event) =>
                setColumnCheckDialog((current) =>
                  current ? { ...current, text: event.target.value } : current
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                className="focus-ring inline-flex h-9 items-center justify-center rounded-md border border-[color:var(--line)] px-3 text-sm font-semibold transition hover:bg-[color:var(--panel-muted)]"
                type="button"
                onClick={() => setColumnCheckDialog(null)}
              >
                Cancel
              </button>
              <button
                className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)] px-3 text-sm font-semibold text-black transition hover:opacity-90"
                type="submit"
              >
                <Save size={15} />
                Check
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
