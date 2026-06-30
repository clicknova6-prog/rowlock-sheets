import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/token";
import { getFirebaseActorByUid } from "@/lib/firebase/users";
import { assertColumnKey, getCellKey, isValidRowIndex } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getRowsForPersistedCellUpdates } from "@/lib/sheet/row-payloads";
import { SheetRuleError, bulkUpdateCells, claimRowForEdit } from "@/lib/sheet/service";
import type {
  CellBlurPayload,
  CellFocusPayload,
  CellLockedPayload,
  CellUnlockedPayload,
  CellUpdatePayload,
  CellUpdateItemPayload,
  CellsUpdatePayload,
  ClientToServerEvents,
  JoinSheetPayload,
  RowClaimPayload,
  ServerToClientEvents
} from "@/lib/sheet/socket-types";
import type { Actor } from "@/lib/sheet/types";

const globalScope = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

globalScope.AsyncLocalStorage ??= AsyncLocalStorage;

const dev = process.env.NODE_ENV !== "production";

function getCliOption(...names: string[]): string | undefined {
  for (const name of names) {
    const prefixedName = name.startsWith("-") ? name : `--${name}`;
    const inlineOption = process.argv.find((arg) => arg.startsWith(`${prefixedName}=`));

    if (inlineOption) {
      return inlineOption.slice(prefixedName.length + 1);
    }

    const optionIndex = process.argv.indexOf(prefixedName);

    if (optionIndex >= 0) {
      return process.argv[optionIndex + 1];
    }
  }

  return undefined;
}

const hostname = getCliOption("hostname", "host", "-H") ?? process.env.HOST ?? "0.0.0.0";
const port = Number(getCliOption("port", "-p") ?? process.env.PORT ?? 3000);
const MAX_SOCKET_BULK_UPDATES = 1000;
const SOCKET_WRITE_FLUSH_DELAY_MS = 1000;
const SOCKET_MEMBER_WRITE_FLUSH_DELAY_MS = 250;
const SOCKET_WRITE_FLUSH_CHUNK_SIZE = 1000;
const sheetWriteQueues = new Map<string, Promise<void>>();
const pendingCellWriteBuffers = new Map<string, PendingCellWriteBuffer>();

type SheetSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: {
    user: Actor;
    joinedSheetIds: Set<string>;
    lockKeys: Set<string>;
  };
};

interface PendingCellWriteBuffer {
  sheetId: string;
  actor: Actor;
  updates: Map<string, CellUpdateItemPayload>;
  socketIds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader.split(";").flatMap((cookie) => {
      const [rawName, ...rawValue] = cookie.trim().split("=");

      if (!rawName) {
        return [];
      }

      return [[rawName, decodeURIComponent(rawValue.join("="))]];
    })
  );
}

function roomName(sheetId: string): string {
  return `sheet:${sheetId}`;
}

async function getUserFromSessionToken(token: string): Promise<Actor | null> {
  const session = await verifySessionToken(token);

  if (!session) {
    return null;
  }

  return (await getFirebaseActorByUid(session.id)) ?? session;
}

function socketLockKey(sheetId: string, row: number, col: string): string {
  return `${sheetId}:${getCellKey(row, col)}`;
}

function getUserColor(userId: string): string {
  const colors = [
    "#0f766e",
    "#1d4ed8",
    "#7c3aed",
    "#be123c",
    "#b45309",
    "#047857",
    "#0369a1",
    "#c2410c"
  ];
  let hash = 0;

  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }

  return colors[hash % colors.length];
}

function enqueueSheetWrite<T>(sheetId: string, task: () => Promise<T>): Promise<T> {
  const previousTask = sheetWriteQueues.get(sheetId) ?? Promise.resolve();
  const nextTask = previousTask.catch(() => undefined).then(task);
  const storedTask = nextTask.then(
    () => undefined,
    () => undefined
  );

  sheetWriteQueues.set(sheetId, storedTask);
  void storedTask.finally(() => {
    if (sheetWriteQueues.get(sheetId) === storedTask) {
      sheetWriteQueues.delete(sheetId);
    }
  });

  return nextTask;
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function emitCellError(
  socket: SheetSocket,
  payload: Partial<CellUpdatePayload> & { message: string }
): void {
  socket.emit("cell-error", {
    sheetId: payload.sheetId,
    row: payload.row,
    col: payload.col,
    message: payload.message
  });
}

function pendingCellWriteKey(sheetId: string, userId: string): string {
  return `${sheetId}:${userId}`;
}

function schedulePendingCellWrite(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  sheetId: string,
  updates: CellUpdateItemPayload[]
): void {
  const key = pendingCellWriteKey(sheetId, socket.data.user.id);
  let buffer = pendingCellWriteBuffers.get(key);

  if (!buffer) {
    buffer = {
      sheetId,
      actor: socket.data.user,
      updates: new Map(),
      socketIds: new Set(),
      timer: null
    };
    pendingCellWriteBuffers.set(key, buffer);
  }

  buffer.actor = socket.data.user;
  buffer.socketIds.add(socket.id);

  for (const update of updates) {
    buffer.updates.set(getCellKey(update.row, update.col), update);
  }

  if (buffer.updates.size >= SOCKET_WRITE_FLUSH_CHUNK_SIZE) {
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    void flushPendingCellWriteBuffer(io, key);
    return;
  }

  if (!buffer.timer) {
    const flushDelay =
      socket.data.user.role === Role.MEMBER
        ? SOCKET_MEMBER_WRITE_FLUSH_DELAY_MS
        : SOCKET_WRITE_FLUSH_DELAY_MS;

    buffer.timer = setTimeout(() => {
      const pendingBuffer = pendingCellWriteBuffers.get(key);

      if (pendingBuffer) {
        pendingBuffer.timer = null;
      }

      void flushPendingCellWriteBuffer(io, key);
    }, flushDelay);
  }
}

async function flushPendingCellWriteBuffer(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  key: string
): Promise<void> {
  const buffer = pendingCellWriteBuffers.get(key);

  if (!buffer) {
    return;
  }

  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  const updates = [...buffer.updates.values()].slice(0, SOCKET_WRITE_FLUSH_CHUNK_SIZE);

  if (updates.length === 0) {
    pendingCellWriteBuffers.delete(key);
    return;
  }

  for (const update of updates) {
    buffer.updates.delete(getCellKey(update.row, update.col));
  }

  const socketIds = new Set(buffer.socketIds);
  const { actor, sheetId } = buffer;

  if (buffer.updates.size === 0) {
    pendingCellWriteBuffers.delete(key);
  } else if (!buffer.timer) {
    buffer.timer = setTimeout(() => {
      const pendingBuffer = pendingCellWriteBuffers.get(key);

      if (pendingBuffer) {
        pendingBuffer.timer = null;
      }

      void flushPendingCellWriteBuffer(io, key);
    }, 0);
  }

  try {
    const snapshot = await enqueueSheetWrite(sheetId, () =>
      bulkUpdateCells(actor, {
        sheetId,
        updates: updates.map((update) => ({
          rowIndex: update.row,
          columnKey: update.col,
          value: update.value
        }))
      })
    );

    io.to(roomName(sheetId)).emit("cells-changed", {
      sheetId,
      updates,
      userId: actor.id,
      rows: getRowsForPersistedCellUpdates(
        snapshot,
        updates.map((update) => ({
          rowIndex: update.row,
          columnKey: update.col
        }))
      ),
      persisted: true
    });
  } catch (error) {
    const message =
      error instanceof SheetRuleError
        ? error.message
        : "Some live changes could not be saved. Refreshing the sheet from the database.";

    for (const socketId of socketIds) {
      io.to(socketId).emit("cell-error", {
        sheetId,
        message
      });
    }

    io.to(roomName(sheetId)).emit("cell-error", {
      sheetId,
      message: "Some live changes could not be saved. Refreshing the sheet from the database."
    });

    if (!(error instanceof SheetRuleError)) {
      console.error(error);
    }
  }
}

async function acquireCellLock(
  input: CellFocusPayload,
  userId: string
): Promise<string | null> {
  const lockWhere = {
    sheetId: input.sheetId,
    rowIndex: input.row,
    columnKey: input.col,
    OR: [{ lockedBy: null }, { lockedBy: userId }]
  };
  const updatedExistingCell = await prisma.cell.updateMany({
    where: lockWhere,
    data: { lockedBy: userId }
  });

  if (updatedExistingCell.count > 0) {
    return userId;
  }

  const existingCell = await prisma.cell.findUnique({
    where: {
      sheetId_rowIndex_columnKey: {
        sheetId: input.sheetId,
        rowIndex: input.row,
        columnKey: input.col
      }
    },
    select: { lockedBy: true }
  });

  if (existingCell?.lockedBy) {
    return existingCell.lockedBy;
  }

  try {
    await prisma.cell.create({
      data: {
        sheetId: input.sheetId,
        rowIndex: input.row,
        columnKey: input.col,
        value: "",
        lockedBy: userId
      }
    });
    return userId;
  } catch (error) {
    if (!isPrismaErrorCode(error, "P2002")) {
      throw error;
    }

    const retryLock = await prisma.cell.updateMany({
      where: lockWhere,
      data: { lockedBy: userId }
    });

    if (retryLock.count > 0) {
      return userId;
    }

    const currentCell = await prisma.cell.findUnique({
      where: {
        sheetId_rowIndex_columnKey: {
          sheetId: input.sheetId,
          rowIndex: input.row,
          columnKey: input.col
        }
      },
      select: { lockedBy: true }
    });

    return currentCell?.lockedBy ?? null;
  }
}

async function getAuthenticatedUser(socket: Socket): Promise<Actor | null> {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  return getUserFromSessionToken(token);
}

function normalizeJoinPayload(payload: JoinSheetPayload | string): string | null {
  if (typeof payload === "string") {
    return payload || null;
  }

  return payload.sheetId || null;
}

function normalizeCellPayload<
  T extends CellFocusPayload | CellBlurPayload | CellUpdatePayload | RowClaimPayload
>(
  payload: T
): T {
  return {
    ...payload,
    col: assertColumnKey(payload.col)
  };
}

function normalizeCellsPayload(payload: CellsUpdatePayload): CellsUpdatePayload {
  return {
    ...payload,
    updates: payload.updates.map((update) => ({
      row: update.row,
      col: assertColumnKey(update.col),
      value: update.value
    }))
  };
}

async function releaseLocksForUser(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  userId: string,
  lockKeys: Set<string>
): Promise<void> {
  const lockedCellsFromSocket = [...lockKeys].flatMap((lockKey) => {
    const [sheetId, rowIndex, columnKey] = lockKey.split(":");
    const row = Number(rowIndex);

    if (!sheetId || !isValidRowIndex(row) || !columnKey) {
      return [];
    }

    return [{ sheetId, rowIndex: row, columnKey }];
  });

  if (lockedCellsFromSocket.length === 0) {
    return;
  }

  const lockedCells = await prisma.cell.findMany({
    where: {
      lockedBy: userId,
      OR: lockedCellsFromSocket.map((cell) => ({
        sheetId: cell.sheetId,
        rowIndex: cell.rowIndex,
        columnKey: cell.columnKey
      }))
    },
    select: { sheetId: true, rowIndex: true, columnKey: true }
  });

  if (lockedCells.length === 0) {
    return;
  }

  await prisma.cell.updateMany({
    where: {
      lockedBy: userId,
      OR: lockedCells.map((cell) => ({
        sheetId: cell.sheetId,
        rowIndex: cell.rowIndex,
        columnKey: cell.columnKey
      }))
    },
    data: { lockedBy: null }
  });

  for (const cell of lockedCells) {
    io.to(roomName(cell.sheetId)).emit("cell-unlocked", {
      sheetId: cell.sheetId,
      row: cell.rowIndex,
      col: assertColumnKey(cell.columnKey)
    });
  }
}

async function joinSheet(socket: SheetSocket, payload: JoinSheetPayload | string): Promise<void> {
  const sheetId = normalizeJoinPayload(payload);

  if (!sheetId) {
    emitCellError(socket, { message: "Sheet id is required." });
    return;
  }

  const sheet = await prisma.sheet.findUnique({
    where: { id: sheetId },
    select: { id: true }
  });

  if (!sheet) {
    emitCellError(socket, { sheetId, message: "Sheet not found." });
    return;
  }

  socket.join(roomName(sheetId));
  socket.data.joinedSheetIds.add(sheetId);

  const locks = await prisma.cell.findMany({
    where: { sheetId, lockedBy: { not: null } },
    select: { rowIndex: true, columnKey: true, lockedBy: true }
  });

  socket.emit("sheet-locks", {
    sheetId,
    locks: locks.flatMap((lock) => {
      if (!lock.lockedBy) {
        return [];
      }

      return [
        {
          sheetId,
          row: lock.rowIndex,
          col: assertColumnKey(lock.columnKey),
          userId: lock.lockedBy,
          userColor: getUserColor(lock.lockedBy)
        } satisfies CellLockedPayload
      ];
    })
  });
}

async function focusCell(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  payload: CellFocusPayload
): Promise<void> {
  const input = normalizeCellPayload(payload);

  if (!isValidRowIndex(input.row)) {
    emitCellError(socket, { ...input, message: "Rows must be between 1 and 1000." });
    return;
  }

  const lockedBy = await acquireCellLock(input, socket.data.user.id);

  if (lockedBy && lockedBy !== socket.data.user.id) {
    socket.emit("cell-locked", {
      sheetId: input.sheetId,
      row: input.row,
      col: input.col,
      userId: lockedBy,
      userColor: getUserColor(lockedBy)
    });
    emitCellError(socket, {
      ...input,
      message: "This cell is currently being edited by another user."
    });
    return;
  }

  if (!lockedBy) {
    emitCellError(socket, {
      ...input,
      message: "Unable to lock the cell."
    });
    return;
  }

  socket.data.lockKeys.add(socketLockKey(input.sheetId, input.row, input.col));

  io.to(roomName(input.sheetId)).emit("cell-locked", {
    sheetId: input.sheetId,
    row: input.row,
    col: input.col,
    userId: socket.data.user.id,
    userColor: getUserColor(socket.data.user.id)
  });
}

async function blurCell(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  payload: CellBlurPayload
): Promise<void> {
  const input = normalizeCellPayload(payload);

  await prisma.cell.updateMany({
    where: {
      sheetId: input.sheetId,
      rowIndex: input.row,
      columnKey: input.col,
      lockedBy: socket.data.user.id
    },
    data: { lockedBy: null }
  });

  socket.data.lockKeys.delete(socketLockKey(input.sheetId, input.row, input.col));

  io.to(roomName(input.sheetId)).emit("cell-unlocked", {
    sheetId: input.sheetId,
    row: input.row,
    col: input.col
  } satisfies CellUnlockedPayload);
}

async function updateCellFromSocket(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  payload: CellUpdatePayload
): Promise<void> {
  const input = normalizeCellPayload(payload);

  await updateCellsFromSocket(io, socket, {
    sheetId: input.sheetId,
    updates: [
      {
        row: input.row,
        col: input.col,
        value: input.value
      }
    ]
  });
}

async function claimRowFromSocket(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  payload: RowClaimPayload
): Promise<void> {
  const input = normalizeCellPayload(payload);

  if (!isValidRowIndex(input.row)) {
    emitCellError(socket, { ...input, message: "Rows must be between 1 and 1000." });
    return;
  }

  if (socket.data.user.role === Role.ADMIN) {
    return;
  }

  const snapshot = await claimRowForEdit(socket.data.user, {
    sheetId: input.sheetId,
    rowIndex: input.row,
    columnKey: input.col
  });

  io.to(roomName(input.sheetId)).emit("row-claimed", {
    sheetId: input.sheetId,
    row: input.row,
    col: input.col,
    userId: socket.data.user.id,
    rows: snapshot.rows.filter((row) => row.rowNumber === input.row)
  });
}

async function updateCellsFromSocket(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: SheetSocket,
  payload: CellsUpdatePayload
): Promise<void> {
  const input = normalizeCellsPayload(payload);

  if (input.updates.length === 0) {
    return;
  }

  if (input.updates.length > MAX_SOCKET_BULK_UPDATES) {
    emitCellError(socket, {
      sheetId: input.sheetId,
      message: `Paste is too large for one sync. Please paste ${MAX_SOCKET_BULK_UPDATES} cells or fewer at a time.`
    });
    return;
  }

  for (const update of input.updates) {
    if (!isValidRowIndex(update.row)) {
      emitCellError(socket, {
        sheetId: input.sheetId,
        message: "Rows must be between 1 and 1000."
      });
      return;
    }

    if (update.value.length > 10000) {
      emitCellError(socket, {
        sheetId: input.sheetId,
        message: `${update.col}${update.row}: Cell value is too long.`
      });
      return;
    }
  }

  const targetRows = [...new Set(input.updates.map((update) => update.row))];
  const targetColumns = [...new Set(input.updates.map((update) => update.col))];
  const targetKeys = new Set(
    input.updates.map((update) => getCellKey(update.row, update.col))
  );
  const lockedCells = await prisma.cell.findMany({
    where: {
      sheetId: input.sheetId,
      rowIndex: { in: targetRows },
      columnKey: { in: targetColumns },
      lockedBy: { not: null }
    },
    select: { rowIndex: true, columnKey: true, lockedBy: true }
  });
  const lockedByOther = lockedCells.find(
    (cell) =>
      cell.lockedBy &&
      cell.lockedBy !== socket.data.user.id &&
      targetKeys.has(getCellKey(cell.rowIndex, cell.columnKey))
  );

  if (lockedByOther?.lockedBy) {
    emitCellError(socket, {
      sheetId: input.sheetId,
      message: `${lockedByOther.columnKey}${lockedByOther.rowIndex} is currently being edited by another user.`
    });
    return;
  }

  io.to(roomName(input.sheetId)).emit("cells-changed", {
    sheetId: input.sheetId,
    updates: input.updates,
    userId: socket.data.user.id,
    persisted: false
  });

  schedulePendingCellWrite(io, socket, input.sheetId, input.updates);
}

async function main(): Promise<void> {
  const { default: next } = await import("next");
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();
  await prisma.cell.updateMany({
    where: { lockedBy: { not: null } },
    data: { lockedBy: null }
  });

  const httpServer = createServer((request, response) => {
    void handle(request, response);
  });
  const corsOrigin = process.env.SOCKET_CORS_ORIGIN;
  const corsOrigins = corsOrigin
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: corsOrigins?.length
      ? {
          origin: corsOrigins,
          credentials: true
        }
      : undefined
  });

  io.use(async (socket, nextHandler) => {
    try {
      const user = await getAuthenticatedUser(socket);

      if (!user) {
        nextHandler(new Error("Authentication required."));
        return;
      }

      const sheetSocket = socket as SheetSocket;
      sheetSocket.data.user = user;
      sheetSocket.data.joinedSheetIds = new Set();
      sheetSocket.data.lockKeys = new Set();
      nextHandler();
    } catch (error) {
      nextHandler(error instanceof Error ? error : new Error("Socket authentication failed."));
    }
  });

  io.on("connection", (socket) => {
    const sheetSocket = socket as SheetSocket;

    sheetSocket.on("join-sheet", (payload) => {
      void joinSheet(sheetSocket, payload).catch((error: unknown) => {
        console.error(error);
        emitCellError(sheetSocket, { message: "Unable to join the sheet." });
      });
    });

    sheetSocket.on("row-claim", (payload) => {
      void enqueueSheetWrite(payload.sheetId, () =>
        claimRowFromSocket(io, sheetSocket, payload)
      ).catch((error: unknown) => {
        if (error instanceof SheetRuleError) {
          emitCellError(sheetSocket, { ...payload, message: error.message });
          return;
        }

        console.error(error);
        emitCellError(sheetSocket, { ...payload, message: "Unable to claim this row." });
      });
    });

    sheetSocket.on("cell-focus", (payload) => {
      void enqueueSheetWrite(payload.sheetId, () => focusCell(io, sheetSocket, payload)).catch((error: unknown) => {
        console.error(error);
        emitCellError(sheetSocket, { ...payload, message: "Unable to lock the cell." });
      });
    });

    sheetSocket.on("cell-blur", (payload) => {
      void enqueueSheetWrite(payload.sheetId, () => blurCell(io, sheetSocket, payload)).catch((error: unknown) => {
        console.error(error);
        emitCellError(sheetSocket, { ...payload, message: "Unable to unlock the cell." });
      });
    });

    sheetSocket.on("cell-update", (payload) => {
      void updateCellFromSocket(io, sheetSocket, payload).catch((error: unknown) => {
        if (error instanceof SheetRuleError) {
          emitCellError(sheetSocket, { ...payload, message: error.message });
          return;
        }

        console.error(error);
        emitCellError(sheetSocket, { ...payload, message: "Unable to save the cell." });
      });
    });

    sheetSocket.on("cells-update", (payload) => {
      void updateCellsFromSocket(io, sheetSocket, payload).catch((error: unknown) => {
        if (error instanceof SheetRuleError) {
          emitCellError(sheetSocket, {
            sheetId: payload.sheetId,
            message: error.message
          });
          return;
        }

        console.error(error);
        emitCellError(sheetSocket, {
          sheetId: payload.sheetId,
          message: "Unable to save the pasted cells."
        });
      });
    });

    sheetSocket.on("disconnect", () => {
      void releaseLocksForUser(
        io,
        sheetSocket.data.user.id,
        sheetSocket.data.lockKeys
      ).catch((error: unknown) => {
        console.error(error);
      });
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`Ready on http://${hostname}:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
