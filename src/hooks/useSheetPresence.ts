"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp
} from "firebase/firestore";
import { Role } from "@/generated/prisma/enums";
import { firebaseAuth, firebaseDb } from "@/lib/firebase/client";
import type { Actor, AppRole } from "@/lib/sheet/types";

export interface SheetPresenceUser {
  userId: string;
  name: string;
  role: AppRole;
  color: string;
  updatedAtMs: number;
}

interface UseSheetPresenceOptions {
  sheetId: string;
  currentUser: Actor;
  enabled?: boolean;
  watch?: boolean;
}

interface UseSheetPresenceResult {
  connected: boolean;
  users: SheetPresenceUser[];
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVE_WINDOW_MS = 75_000;
const PRESENCE_CLOCK_TICK_MS = 5_000;
const PRESENCE_LIST_LIMIT = 120;
const PRESENCE_COLORS = [
  "#0f766e",
  "#1d4ed8",
  "#7c3aed",
  "#be123c",
  "#b45309",
  "#047857",
  "#4338ca",
  "#a21caf",
  "#0369a1",
  "#15803d"
];

function getPresenceColor(userId: string): string {
  let hash = 0;

  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }

  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

function toTimestampMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  return null;
}

function toPresenceUser(id: string, data: Record<string, unknown>): SheetPresenceUser | null {
  if (
    typeof data.userId !== "string" ||
    id !== data.userId ||
    typeof data.name !== "string" ||
    !(data.role === Role.ADMIN || data.role === Role.MEMBER) ||
    typeof data.color !== "string"
  ) {
    return null;
  }

  const updatedAtMs = toTimestampMillis(data.updatedAt);

  if (!updatedAtMs) {
    return null;
  }

  return {
    userId: data.userId,
    name: data.name,
    role: data.role,
    color: data.color,
    updatedAtMs
  };
}

export function useSheetPresence({
  sheetId,
  currentUser,
  enabled = true,
  watch = false
}: UseSheetPresenceOptions): UseSheetPresenceResult {
  const [authState, setAuthState] = useState(() => ({
    ready: Boolean(firebaseAuth.currentUser),
    userId: firebaseAuth.currentUser?.uid ?? null
  }));
  const [heartbeatConnected, setHeartbeatConnected] = useState(false);
  const [heartbeatKey, setHeartbeatKey] = useState<string | null>(null);
  const [watchConnected, setWatchConnected] = useState(false);
  const [watchedSheetId, setWatchedSheetId] = useState<string | null>(null);
  const [watchedUsers, setWatchedUsers] = useState<SheetPresenceUser[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const warnedHeartbeatRef = useRef(false);
  const currentPresenceKey = `${sheetId}:${currentUser.id}`;

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (user) => {
      setAuthState({
        ready: true,
        userId: user?.uid ?? null
      });
    });
  }, []);

  useEffect(() => {
    if (!enabled || !watch) {
      return;
    }

    const clock = window.setInterval(() => {
      setNowMs(Date.now());
    }, PRESENCE_CLOCK_TICK_MS);

    return () => {
      window.clearInterval(clock);
    };
  }, [enabled, watch]);

  useEffect(() => {
    if (!enabled || !sheetId || !authState.ready || authState.userId !== currentUser.id) {
      return;
    }

    let stopped = false;
    const presenceRef = doc(firebaseDb, "sheetPresence", sheetId, "users", currentUser.id);

    const writePresence = async () => {
      try {
        await setDoc(presenceRef, {
          sheetId,
          userId: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          color: getPresenceColor(currentUser.id),
          updatedAt: serverTimestamp()
        });

        if (!stopped) {
          warnedHeartbeatRef.current = false;
          setHeartbeatKey(currentPresenceKey);
          setHeartbeatConnected(true);
        }
      } catch (error) {
        if (!stopped) {
          setHeartbeatKey(null);
          setHeartbeatConnected(false);
        }

        if (!warnedHeartbeatRef.current) {
          warnedHeartbeatRef.current = true;
          console.warn("Unable to update sheet presence.", error);
        }
      }
    };

    void writePresence();

    const heartbeat = window.setInterval(() => {
      void writePresence();
    }, HEARTBEAT_INTERVAL_MS);

    const writeWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void writePresence();
      }
    };

    const deletePresence = () => {
      void deleteDoc(presenceRef).catch(() => undefined);
    };

    window.addEventListener("focus", writeWhenVisible);
    window.addEventListener("pagehide", deletePresence);
    document.addEventListener("visibilitychange", writeWhenVisible);

    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", writeWhenVisible);
      window.removeEventListener("pagehide", deletePresence);
      document.removeEventListener("visibilitychange", writeWhenVisible);
      deletePresence();
    };
  }, [
    authState.ready,
    authState.userId,
    currentUser.id,
    currentUser.name,
    currentUser.role,
    enabled,
    currentPresenceKey,
    sheetId
  ]);

  useEffect(() => {
    if (!enabled || !watch || !sheetId || !authState.ready || !authState.userId) {
      return;
    }

    const presenceQuery = query(
      collection(firebaseDb, "sheetPresence", sheetId, "users"),
      orderBy("updatedAt", "desc"),
      limit(PRESENCE_LIST_LIMIT)
    );

    const unsubscribe = onSnapshot(
      presenceQuery,
      (snapshot) => {
        const nextUsers = snapshot.docs
          .map((presenceDoc) => toPresenceUser(presenceDoc.id, presenceDoc.data()))
          .filter((user): user is SheetPresenceUser => Boolean(user));

        setWatchedUsers(nextUsers);
        setWatchedSheetId(sheetId);
        setWatchConnected(true);
      },
      (error) => {
        console.error("Unable to watch sheet presence.", error);
        setWatchedSheetId(null);
        setWatchConnected(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [authState.ready, authState.userId, enabled, sheetId, watch]);

  const activeUsers = useMemo(
    () =>
      enabled && watch && watchedSheetId === sheetId
        ? watchedUsers.filter((user) => nowMs - user.updatedAtMs <= ACTIVE_WINDOW_MS)
        : [],
    [enabled, nowMs, sheetId, watch, watchedSheetId, watchedUsers]
  );
  const heartbeatReady =
    enabled &&
    Boolean(sheetId) &&
    authState.ready &&
    authState.userId === currentUser.id &&
    heartbeatConnected &&
    heartbeatKey === currentPresenceKey;
  const watchReady =
    !watch ||
    (enabled &&
      Boolean(sheetId) &&
      authState.ready &&
      Boolean(authState.userId) &&
      watchConnected &&
      watchedSheetId === sheetId);

  return {
    connected: heartbeatReady && watchReady,
    users: activeUsers
  };
}
