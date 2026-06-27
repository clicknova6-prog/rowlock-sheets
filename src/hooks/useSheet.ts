"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ColumnKey } from "@/lib/constants";
import type {
  CellChangedPayload,
  CellErrorPayload,
  CellLockedPayload,
  CellUnlockedPayload,
  CellUpdateItemPayload,
  CellsChangedPayload,
  ClientToServerEvents,
  RowClaimedPayload,
  ServerToClientEvents,
  SheetLocksPayload
} from "@/lib/sheet/socket-types";

interface UseSheetCallbacks {
  onCellChanged?: (payload: CellChangedPayload) => void;
  onCellsChanged?: (payload: CellsChangedPayload) => void;
  onRowClaimed?: (payload: RowClaimedPayload) => void;
  onCellLocked?: (payload: CellLockedPayload) => void;
  onCellUnlocked?: (payload: CellUnlockedPayload) => void;
  onSheetLocks?: (payload: SheetLocksPayload) => void;
  onCellError?: (payload: CellErrorPayload) => void;
}

interface UseSheetOptions extends UseSheetCallbacks {
  sheetId: string;
  enabled?: boolean;
}

interface UseSheetResult {
  connected: boolean;
  updateCell: (row: number, col: ColumnKey, value: string) => void;
  updateCells: (updates: CellUpdateItemPayload[]) => void;
  claimRow: (row: number, col: ColumnKey) => void;
  focusCell: (row: number, col: ColumnKey) => void;
  blurCell: (row: number, col: ColumnKey) => void;
}

export function useSheet({
  sheetId,
  enabled = true,
  onCellChanged,
  onCellsChanged,
  onRowClaimed,
  onCellLocked,
  onCellUnlocked,
  onSheetLocks,
  onCellError
}: UseSheetOptions): UseSheetResult {
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const callbacksRef = useRef<UseSheetCallbacks>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    callbacksRef.current = {
      onCellChanged,
      onCellsChanged,
      onRowClaimed,
      onCellLocked,
      onCellUnlocked,
      onSheetLocks,
      onCellError
    };
  }, [onCellChanged, onCellError, onCellLocked, onCellUnlocked, onCellsChanged, onRowClaimed, onSheetLocks]);

  useEffect(() => {
    if (!enabled || !sheetId) {
      return;
    }

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      path: "/socket.io",
      withCredentials: true,
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-sheet", { sheetId });
    });
    socket.on("disconnect", () => {
      setConnected(false);
    });
    socket.on("connect_error", () => {
      setConnected(false);
      callbacksRef.current.onCellError?.({
        sheetId,
        message: "Unable to connect to live sync. Make sure the app is running through server.ts/server.js."
      });
    });
    socket.on("cell-changed", (payload) => {
      callbacksRef.current.onCellChanged?.(payload);
    });
    socket.on("cells-changed", (payload) => {
      callbacksRef.current.onCellsChanged?.(payload);
    });
    socket.on("row-claimed", (payload) => {
      callbacksRef.current.onRowClaimed?.(payload);
    });
    socket.on("cell-locked", (payload) => {
      callbacksRef.current.onCellLocked?.(payload);
    });
    socket.on("cell-unlocked", (payload) => {
      callbacksRef.current.onCellUnlocked?.(payload);
    });
    socket.on("sheet-locks", (payload) => {
      callbacksRef.current.onSheetLocks?.(payload);
    });
    socket.on("cell-error", (payload) => {
      callbacksRef.current.onCellError?.(payload);
    });
    socket.io.on("error", () => {
      callbacksRef.current.onCellError?.({
        sheetId,
        message: "Unable to connect to live sync. Make sure the app is running through server.ts/server.js."
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, sheetId]);

  const updateCell = useCallback(
    (row: number, col: ColumnKey, value: string): void => {
      socketRef.current?.emit("cell-update", { sheetId, row, col, value });
    },
    [sheetId]
  );

  const updateCells = useCallback(
    (updates: CellUpdateItemPayload[]): void => {
      socketRef.current?.emit("cells-update", { sheetId, updates });
    },
    [sheetId]
  );

  const claimRow = useCallback(
    (row: number, col: ColumnKey): void => {
      socketRef.current?.emit("row-claim", { sheetId, row, col });
    },
    [sheetId]
  );

  const focusCell = useCallback(
    (row: number, col: ColumnKey): void => {
      socketRef.current?.emit("cell-focus", { sheetId, row, col });
    },
    [sheetId]
  );

  const blurCell = useCallback(
    (row: number, col: ColumnKey): void => {
      socketRef.current?.emit("cell-blur", { sheetId, row, col });
    },
    [sheetId]
  );

  return {
    connected,
    updateCell,
    updateCells,
    claimRow,
    focusCell,
    blurCell
  };
}
