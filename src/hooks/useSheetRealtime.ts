"use client";

import { useEffect, useRef, useState } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where
} from "firebase/firestore";
import { firebaseDb } from "@/lib/firebase/client";
import type {
  SheetRealtimeEvent,
  SheetRealtimeEventType
} from "@/lib/sheet/realtime-types";

interface UseSheetRealtimeOptions {
  sheetId: string;
  enabled?: boolean;
  onEvent?: (event: SheetRealtimeEvent) => void;
  onError?: (message: string) => void;
}

interface UseSheetRealtimeResult {
  connected: boolean;
}

const EVENT_TYPES = new Set<SheetRealtimeEventType>([
  "cells-changed",
  "format-changed",
  "row-claimed",
  "row-unlocked"
]);

function toRealtimeEvent(id: string, data: Record<string, unknown>): SheetRealtimeEvent | null {
  if (
    typeof data.type !== "string" ||
    !EVENT_TYPES.has(data.type as SheetRealtimeEventType) ||
    typeof data.sheetId !== "string" ||
    typeof data.actorId !== "string"
  ) {
    return null;
  }

  return {
    id,
    type: data.type as SheetRealtimeEventType,
    sheetId: data.sheetId,
    actorId: data.actorId,
    actorName: typeof data.actorName === "string" ? data.actorName : null,
    sourceClientId: typeof data.sourceClientId === "string" ? data.sourceClientId : null,
    rowIndexes: Array.isArray(data.rowIndexes)
      ? data.rowIndexes.filter((rowIndex): rowIndex is number => typeof rowIndex === "number")
      : undefined,
    cellCount: typeof data.cellCount === "number" ? data.cellCount : undefined,
    updates: Array.isArray(data.updates) ? (data.updates as SheetRealtimeEvent["updates"]) : undefined,
    rows: Array.isArray(data.rows) ? (data.rows as SheetRealtimeEvent["rows"]) : undefined,
    requiresRefresh: data.requiresRefresh === true
  };
}

export function useSheetRealtime({
  sheetId,
  enabled = true,
  onEvent,
  onError
}: UseSheetRealtimeOptions): UseSheetRealtimeResult {
  const callbacksRef = useRef({ onEvent, onError });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    callbacksRef.current = { onEvent, onError };
  }, [onError, onEvent]);

  useEffect(() => {
    if (!enabled || !sheetId) {
      return;
    }

    const subscribedAfter = Timestamp.fromMillis(Date.now() - 3000);
    const eventsQuery = query(
      collection(firebaseDb, "sheetRealtime", sheetId, "events"),
      where("createdAt", ">", subscribedAfter),
      orderBy("createdAt", "asc"),
      limit(100)
    );

    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        setConnected(true);

        for (const change of snapshot.docChanges()) {
          if (change.type === "removed") {
            continue;
          }

          const event = toRealtimeEvent(change.doc.id, change.doc.data());

          if (event) {
            callbacksRef.current.onEvent?.(event);
          }
        }
      },
      (error) => {
        setConnected(false);
        console.error(error);
        callbacksRef.current.onError?.("Unable to connect to Firestore realtime updates.");
      }
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [enabled, sheetId]);

  return { connected };
}
