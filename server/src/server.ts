import express from "express";
import http from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import type { ClientToServerMssg,ServerToClientMssg } from "./types/index";
import type { ClientId } from "./utils/rate-limitter";
import isRateLimitted , {msgCount} from "./utils/rate-limitter";

import { randomUUID } from "node:crypto";
import {
  addClientToRoom,
  removeClientFromRoom,
  isClientInRoom,
  getRoomMembers,
  getRoomSize,
  refreshRoomTtl,
  setOwnerToken,
  getOwnerToken,
  clearOwnerToken,
  publishToClient,
  sendToRoom,
  subscribeToChannel,
  disconnectRedis,
} from "./utils/redis";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

// Allow the client origin to read these routes cross-origin.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connections: wss.clients.size,
  });
});

app.get("/room/:roomId", async (req, res) => {
  const count = await getRoomSize(req.params.roomId);
  res.json({ exists: count > 0 });
});

type RoomId = string;


function logRejection(event: string, clientId: string, reason: string): void {
  console.error(
    JSON.stringify({
      level: "warn",
      ts: new Date().toISOString(),
      event,
      clientId,
      reason,
    }),
  );
}

const clientIdToRoomId: Record<ClientId, RoomId> = {};
const clientIdToSocket: Record<ClientId, WebSocket> = {};
const socketToClientId = new Map<WebSocket, ClientId>();
const socketToOwnerToken = new Map<WebSocket, string>();


const GRACE_PERIOD_MS = 5000;
const pendingRemoval: Record<ClientId, ReturnType<typeof setTimeout>> = {};

function send(ws: WebSocket, msg: ServerToClientMssg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

subscribeToChannel<ServerToClientMssg>((targetClientId, payload) => {
  const target = clientIdToSocket[targetClientId];
  if (target) send(target, payload);
});

async function handleJoinRoom(
  ws: WebSocket,
  msg: Extract<ClientToServerMssg, { type: "join-room" }>,
): Promise<void> {
  const { roomId, clientId } = msg;
  if (typeof roomId !== "string" || roomId.length < 1 || roomId.length > 64) {
    logRejection("join-room", clientId, "invalid roomId");
    return;
  }
  if (
    typeof clientId !== "string" ||
    clientId.length < 1 ||
    clientId.length > 100
  ) {
    logRejection("join-room", "unknown", "invalid clientId");
    return;
  }

  socketToClientId.set(ws, clientId);
  const ownerToken = randomUUID();
  socketToOwnerToken.set(ws, ownerToken);
  await setOwnerToken(clientId, ownerToken);

  
  if (pendingRemoval[clientId]) {
    clearTimeout(pendingRemoval[clientId]);
    delete pendingRemoval[clientId];
  }
  clientIdToSocket[clientId] = ws;

  if (await isClientInRoom(roomId, clientId)) {
    clientIdToRoomId[clientId] = roomId;
    await refreshRoomTtl(roomId);
    const members = await getRoomMembers(roomId);
    send(ws, {
      type: "all-users",
      users: members.filter((id) => id !== clientId),
    });
    return;
  }

  const roomSize = await getRoomSize(roomId);
  if (roomSize >= 2) {
    send(ws, { type: "room-full" });
    return;
  }
  await addClientToRoom(roomId, clientId);
  clientIdToRoomId[clientId] = roomId;

  const members = await getRoomMembers(roomId);
  send(ws, {
    type: "all-users",
    users: members.filter((id) => id !== clientId),
  });
}

async function handleSendingSignal(
  clientId: ClientId,
  msg: Extract<ClientToServerMssg, { type: "sending-signal" }>,
): Promise<void> {
  if (typeof msg.userToSignal !== "string" || !msg.signal) {
    logRejection("sending-signal", clientId, "malformed payload");
    return;
  }
  const roomId = clientIdToRoomId[clientId];
  const targetInRoom = roomId && (await isClientInRoom(roomId, msg.userToSignal));
  if (!roomId || !targetInRoom) {
    logRejection("sending-signal", clientId, "target not in same room");
    return;
  }
  if (JSON.stringify(msg.signal).length > 65536) {
    logRejection("sending-signal", clientId, "signal payload too large");
    return;
  }

  await publishToClient<ServerToClientMssg>(msg.userToSignal, {
    type: "user-joined",
    signal: msg.signal,
    callerID: clientId, // use verified server-side id, not anything client-claimed
  });
}

async function handleReturningSignal(
  clientId: ClientId,
  msg: Extract<ClientToServerMssg, { type: "returning-signal" }>,
): Promise<void> {
  if (typeof msg.callerID !== "string" || !msg.signal) {
    logRejection("returning-signal", clientId, "malformed payload");
    return;
  }
  const roomId = clientIdToRoomId[clientId];
  const callerInRoom = roomId && (await isClientInRoom(roomId, msg.callerID));
  if (!roomId || !callerInRoom) {
    logRejection("returning-signal", clientId, "caller not in same room");
    return;
  }
  if (JSON.stringify(msg.signal).length > 65536) {
    logRejection("returning-signal", clientId, "signal payload too large");
    return;
  }

  await publishToClient<ServerToClientMssg>(msg.callerID, {
    type: "receiving-returned-signal",
    signal: msg.signal,
    id: clientId,
  });
}


async function removeClient(
  clientId: ClientId,
  ownerToken: string,
): Promise<void> {
  const currentToken = await getOwnerToken(clientId);
  if (currentToken !== ownerToken) {
    return;
  }

  const roomId = clientIdToRoomId[clientId];
  if (roomId) {
    await removeClientFromRoom(roomId, clientId);
    await sendToRoom<ServerToClientMssg>(roomId, clientId, {
      type: "user-left",
      id: clientId,
    });
  }
  delete clientIdToRoomId[clientId];
  delete clientIdToSocket[clientId];
  delete msgCount[clientId];
  await clearOwnerToken(clientId);
}

wss.on("connection", (ws) => {
  ws.on("message", (raw: RawData) => {
    void (async () => {
      let msg: ClientToServerMssg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed messages
      }
      if (!msg || typeof msg.type !== "string") return;

      const clientId =
        msg.type === "join-room" ? msg.clientId : socketToClientId.get(ws);
      if (!clientId || typeof clientId !== "string") {
        logRejection(msg.type, "unknown", "message sent before join-room");
        return;
      }

      if (isRateLimitted(clientId)) {
        logRejection(msg.type, clientId, "rate limit exceeded");
        return;
      }

      switch (msg.type) {
        case "join-room":
          await handleJoinRoom(ws, msg);
          break;
        case "sending-signal":
          await handleSendingSignal(clientId, msg);
          break;
        case "returning-signal":
          await handleReturningSignal(clientId, msg);
          break;
      }
    })().catch((err) => console.error("Message handler error:", err));
  });

  ws.on("close", () => {
    const clientId = socketToClientId.get(ws);
    const ownerToken = socketToOwnerToken.get(ws);
    if (!clientId || !ownerToken) return; 
    if (clientIdToSocket[clientId] !== ws) return;

    pendingRemoval[clientId] = setTimeout(() => {
      delete pendingRemoval[clientId];
      removeClient(clientId, ownerToken).catch((err) =>
        console.error("removeClient error:", err),
      );
    }, GRACE_PERIOD_MS);
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log("Shutting down gracefully...");
  for (const client of wss.clients) {
    client.close();
  }
  wss.close(() => {
    disconnectRedis();
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
