"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where
} from "firebase/firestore";
import { firebaseAuth, firebaseDb } from "@/lib/firebase/client";
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
  const [authState, setAuthState] = useState(() => ({
    ready: Boolean(firebaseAuth.currentUser),
    userId: firebaseAuth.currentUser?.uid ?? null
  }));
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    callbacksRef.current = { onEvent, onError };
  }, [onError, onEvent]);

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (user) => {
      setAuthState({
        ready: true,
        userId: user?.uid ?? null
      });
    });
  }, []);

  useEffect(() => {
    if (!enabled || !sheetId || !authState.ready || !authState.userId) {
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
  }, [authState.ready, authState.userId, enabled, sheetId]);

  return { connected };
}
