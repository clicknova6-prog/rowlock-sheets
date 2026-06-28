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
  X
} from "lucide-react";
import {
  Cell,
  DataGrid,
  Row,
  type CellRendererProps,
  type Column,
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
import { useSheetRealtime } from "@/hooks/useSheetRealtime";
import { applyDemoCellFormatUpdate, applyDemoCellUpdate } from "@/lib/sheet/demo-engine";
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

const CELL_AUTOSAVE_DEBOUNCE_MS = 750;
const BULK_AUTOSAVE_DEBOUNCE_MS = 150;
const AUTOSAVE_MAX_BATCH_SIZE = 200;
const SOCKET_BULK_UPDATE_LIMIT = 50;
const REST_BULK_UPDATE_LIMIT = 200;
const LIVE_SYNC_ACK_TIMEOUT_MS = 300000;
const REALTIME_SNAPSHOT_REFRESH_MS = 400;

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

function getRenderedCellValue(row: SheetGridRow, columnKey: ColumnKey): string {
  return row.__formula[columnKey]
    ? row.__computed[columnKey]
    : String(row[columnKey] ?? "");
}

function countEditableColumns(snapshot: SheetSnapshot): number {
  return snapshot.columnPermissions.filter((permission) => permission.editableByMember).length;
}

function estimateWrappedLineCount(value: string): number {
  if (!value) {
    return 1;
  }

  const lines = value.split(/\r\n|\r|\n/);
  return lines.reduce((count, line) => {
    return count + Math.max(1, Math.ceil(line.length / 34));
  }, 0);
}

function getResponsiveRowHeight(row: SheetGridRow, columns: ColumnKey[]): number {
  const maxLines = columns.reduce((lineCount, columnKey) => {
    const cellValue = getRenderedCellValue(row, columnKey);
    return Math.max(lineCount, estimateWrappedLineCount(cellValue));
  }, 1);

  return Math.min(150, Math.max(34, maxLines * 18 + 12));
}

function parseClipboardGrid(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => line.split("\t"));
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
        ownership
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
    style.color = format.textColor;
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

function getCellContainerStyle(
  baseStyle: CSSProperties | undefined,
  format: CellFormatState
): CSSProperties | undefined {
  if (!format.backgroundColor) {
    return baseStyle;
  }

  return {
    ...baseStyle,
    backgroundColor: format.backgroundColor
  };
}

function getAlternateRowBackground(
  row: SheetGridRow,
  viewSetting: SheetViewSettingState
): string | undefined {
  if (!viewSetting.alternateRowColors) {
    return undefined;
  }

  return row.rowNumber % 2 === 0
    ? viewSetting.alternateEvenColor
    : viewSetting.alternateOddColor;
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
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [selectedRange, setSelectedRange] = useState<SelectedCellRange | null>(null);
  const [isRangeSelecting, setIsRangeSelecting] = useState(false);
  const [fillColor, setFillColor] = useState("#fef3c7");
  const [textColor, setTextColor] = useState("#111827");
  const [historyPanel, setHistoryPanel] = useState<CellHistoryPanelState | null>(null);
  const [locks, setLocks] = useState<Map<string, CellLockState>>(new Map());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [isSavingCells, setIsSavingCells] = useState(false);
  const [isPending, startTransition] = useTransition();
  const latestSnapshotRef = useRef(initialSnapshot);
  const saveQueueRef = useRef<Map<string, CellUpdateDraft>>(new Map());
  const inFlightUpdatesRef = useRef<Map<string, CellUpdateDraft>>(new Map());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const flushQueuedCellUpdatesRef = useRef<() => Promise<boolean>>(async () => true);
  const activeSocketCellRef = useRef<SelectedCell | null>(null);
  const rowClaimRequestsRef = useRef<Set<number>>(new Set());
  const clientInstanceIdRef = useRef(createClientInstanceId());
  const socketConnectedRef = useRef(false);
  const socketUpdateCellRef = useRef<(update: CellUpdateDraft) => boolean>(() => false);
  const socketUpdateCellsRef = useRef<(updates: CellUpdateDraft[]) => boolean>(() => false);
  const socketClaimRowRef = useRef<(cell: SelectedCell) => void>(() => undefined);
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
    (row: SheetGridRow) => getResponsiveRowHeight(row, snapshot.columns),
    [snapshot.columns]
  );

  useEffect(() => {
    latestSnapshotRef.current = snapshot;
  }, [snapshot]);

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
    };
  }, []);

  useEffect(() => {
    if (!isRangeSelecting) {
      return;
    }

    function stopRangeSelection(): void {
      setIsRangeSelecting(false);
    }

    window.addEventListener("mouseup", stopRangeSelection);
    window.addEventListener("blur", stopRangeSelection);

    return () => {
      window.removeEventListener("mouseup", stopRangeSelection);
      window.removeEventListener("blur", stopRangeSelection);
    };
  }, [isRangeSelecting]);

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
          error?: string;
        } | null;

        if (!response.ok || !body?.snapshot) {
          throw new Error(body?.error ?? "Unable to save queued changes.");
        }

        saveInFlightRef.current = false;
        setIsSavingCells(false);
        applyServerSnapshot(body.snapshot);
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
  }, [applyServerSnapshot, clearAutosaveTimer, demoMode, scheduleInFlightTimeout, scheduleQueuedSave]);

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

  const applySocketRows = useCallback((incomingRows: SheetGridRow[]): void => {
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
  }, []);

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
      applySocketRows(
        applyUpdatesToRows(latestSnapshotRef.current.rows, [
          {
            rowIndex: payload.row,
            columnKey: payload.col,
            value: payload.value
          }
        ])
      );
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

    applySocketRows(payload.rows);
    setError(null);
    setMessage(
      payload.userId === latestSnapshotRef.current.currentUser.id
        ? `${payload.updates.length} cells synced.`
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
    setMessage(null);
    setError(payload.message);
  }, [clearInFlightTimeout, finishInFlightUpdate, restoreCommittedRowsWithOptimisticEdits, scheduleQueuedSave]);

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
    claimRow: socketClaimRow,
    focusCell: socketFocusCell,
    blurCell: socketBlurCell
  } = sheetSocket;
  const sheetRealtime = useSheetRealtime({
    sheetId: snapshot.sheet.id,
    enabled: firestoreSyncEnabled,
    onEvent: handleFirestoreRealtimeEvent,
    onError: setError
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
    socketClaimRowRef.current = (cell) => {
      if (socketLiveConnected) {
        socketClaimRow(cell.rowIndex, cell.columnKey);
      }
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
  }, [socketBlurCell, socketClaimRow, socketFocusCell, socketLiveConnected, socketUpdateCell, socketUpdateCells]);

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

  const claimHostedRow = useCallback(async (cell: SelectedCell): Promise<void> => {
    const currentSnapshot = latestSnapshotRef.current;
    const targetRow = currentSnapshot.rows.find((row) => row.rowNumber === cell.rowIndex);

    if (
      !targetRow ||
      targetRow.ownerId ||
      rowClaimRequestsRef.current.has(cell.rowIndex)
    ) {
      return;
    }

    rowClaimRequestsRef.current.add(cell.rowIndex);

    try {
      const response = await fetch("/api/rows/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetId: currentSnapshot.sheet.id,
          rowIndex: cell.rowIndex,
          columnKey: cell.columnKey,
          sourceClientId: clientInstanceIdRef.current
        })
      });
      const body = (await response.json().catch(() => null)) as {
        snapshot?: SheetSnapshot;
        error?: string;
      } | null;

      if (!response.ok || !body?.snapshot) {
        throw new Error(body?.error ?? "Unable to claim this row.");
      }

      applyServerSnapshot(body.snapshot);
      setError(null);
      setMessage(`Row ${cell.rowIndex} claimed.`);
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "Unable to claim this row.");
    } finally {
      rowClaimRequestsRef.current.delete(cell.rowIndex);
    }
  }, [applyServerSnapshot]);

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

  const claimLiveRow = useCallback((cell: SelectedCell): void => {
    if (demoMode || snapshot.currentUser.role === Role.ADMIN) {
      return;
    }

    if (socketSyncEnabled) {
      socketClaimRowRef.current(cell);
      return;
    }

    void claimHostedRow(cell);
  }, [claimHostedRow, demoMode, snapshot.currentUser.role, socketSyncEnabled]);

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
    setError(null);
    setMessage(null);

    if (demoMode) {
      let nextSnapshot = snapshot;

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
      setMessage(`${savedLabel} saved locally.`);
      return;
    }

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
    setError(null);
    setMessage("Clearing...");

    if (demoMode) {
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
      setMessage(`Cleared ${updates.length} cell${updates.length === 1 ? "" : "s"} locally.`);
      return;
    }

    queueCellUpdates(
      updates,
      `Cleared ${updates.length} cell${updates.length === 1 ? "" : "s"}.`,
      BULK_AUTOSAVE_DEBOUNCE_MS
    );
  }, [demoMode, locks, queueCellUpdates, rows, selectedCell, selectedRange, snapshot]);

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
    if (!isAdmin || !isRangeSelecting) {
      return;
    }

    setSelectedCell(cell);
    setSelectedRange((currentRange) => {
      if (!currentRange) {
        return { anchor: cell, focus: cell };
      }

      if (
        currentRange.focus.rowIndex === cell.rowIndex &&
        currentRange.focus.columnKey === cell.columnKey
      ) {
        return currentRange;
      }

      return {
        ...currentRange,
        focus: cell
      };
    });
  }, [isAdmin, isRangeSelecting]);

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

      return (
        <Row
          key={key}
          {...props}
          style={
            backgroundColor
              ? { ...props.style, backgroundColor }
              : props.style
          }
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

    setError(null);
    setMessage("Pasting...");

    if (demoMode) {
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
        setRows(applyUpdatesToRows(rows, updates));
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
      setMessage(`Pasted ${appliedCount} cell${appliedCount === 1 ? "" : "s"}.`);
    }

    if (firstError) {
      setError(firstError);
    } else {
      setError(null);
    }
  }, [demoMode, locks, queueCellUpdates, rows, snapshot]);

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
        onFocus={() => {
          if (isColumnKey(columnKey, snapshot.columns)) {
            claimLiveRow({
              rowIndex: row.rowNumber,
              columnKey
            });
          }
        }}
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
  }, [applyPastedText, claimLiveRow, snapshot.columns, startTransition]);

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
          width: 230,
          minWidth: 160,
          maxWidth: 420,
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
                {getRenderedCellValue(row, columnKey)}
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

      <div className="overflow-hidden rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)] shadow-sm">
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
          className={clsx("fill-grid", isRangeSelecting && "sheet-range-selecting")}
          columns={columns}
          renderers={renderers}
          rowHeight={rowHeight}
          rows={rows}
          onRowsChange={handleRowsChange}
          onFill={isAdmin ? handleFill : undefined}
          onCellMouseDown={(args, event) => {
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

              setSelectedCell(anchor);
              setSelectedRange({ anchor, focus });
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

            setSelectedCell(cell);
            setSelectedRange({ anchor: cell, focus: cell });
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

              setSelectedCell(cell);
              focusLiveCell(cell);

              if (!isRangeSelecting) {
                setSelectedRange({ anchor: cell, focus: cell });
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
    </section>
  );
}
