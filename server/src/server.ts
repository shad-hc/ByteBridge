import express from "express";
import http from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";

import type { ClientToServerMssg,ServerToClientMssg } from "./types/index"
import type { ClientId } from "./utils/rate-limitter";
import isRateLimited,{ msgCount } from "./utils/rate-limitter";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

const app = express();
const server = http.createServer(app);


const wss = new WebSocketServer({server});

// Allow the client origin to read these routes cross-origin.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: Object.keys(roomIdToClients).length,
    connections: wss.clients.size,
  });
});


app.get("/room/:roomId", (req, res) => {
  const clients = roomIdToClients[req.params.roomId];
  res.json({ exists: Array.isArray(clients) && clients.length > 0 });
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

const roomIdToClients: Record<RoomId, ClientId[]> = {};
const clientIdToRoomId: Record<ClientId, RoomId> = {};
const roomCreatedAt: Record<RoomId, number> = {};


const clientIdToSocket: Record<ClientId, WebSocket> = {};

const GRACE_PERIOD_MS = 5000;
const pendingRemoval: Record<ClientId, ReturnType<typeof setTimeout>> = {};


const socketToClientId = new Map<WebSocket, ClientId>();



// Sweep zombie rooms older than 1 hour
setInterval(() => {
  const now = Date.now();
  for (const roomId of Object.keys(roomCreatedAt)) {
    if (now - roomCreatedAt[roomId] > 3600000) {
      const clients = roomIdToClients[roomId];
      if (clients) {
        for (const id of clients) delete clientIdToRoomId[id];
      }
      delete roomIdToClients[roomId];
      delete roomCreatedAt[roomId];
    }
  }
}, 60000);

function send(ws: WebSocket, msg: ServerToClientMssg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendToClient(clientId: ClientId, msg: ServerToClientMssg): void {
  const target = clientIdToSocket[clientId];
  if (target) send(target, msg);
}

function sendToRoom(
  roomId: RoomId,
  exceptClientId: ClientId,
  msg: ServerToClientMssg,
): void {
  for (const id of roomIdToClients[roomId] || []) {
    if (id !== exceptClientId) sendToClient(id, msg);
  }
}

function handleJoinRoom(
  ws: WebSocket,
  msg: Extract<ClientToServerMssg, { type: "join-room" }>,
): void {
  const { roomId, clientId } = msg;
  //check valid roomId
  if (typeof roomId !== "string" || roomId.length < 1 || roomId.length > 64) {
    logRejection("join-room", clientId, "invalid roomId");
    return;
  }

  //check valid clientId
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 100) {
    logRejection("join-room", "unknown", "invalid clientId");
    return;
  }

  socketToClientId.set(ws, clientId);

  if (pendingRemoval[clientId]) {
    clearTimeout(pendingRemoval[clientId]);
    delete pendingRemoval[clientId];
  }
  clientIdToSocket[clientId] = ws;

  const alreadyInRoom = roomIdToClients[roomId]?.includes(clientId);
  if (alreadyInRoom) {
    clientIdToRoomId[clientId] = roomId;
    const others = roomIdToClients[roomId].filter((id) => id !== clientId);
    send(ws, { type: "all-users", users: others });
    return;
  }

  // Genuine fresh join.
  if (roomIdToClients[roomId]) {
    if (roomIdToClients[roomId].length >= 2) {
      send(ws, { type: "room-full" });
      return;
    }
    roomIdToClients[roomId].push(clientId);
  } else {
    roomIdToClients[roomId] = [clientId];
    roomCreatedAt[roomId] = Date.now();
  }
  clientIdToRoomId[clientId] = roomId;

  const others = roomIdToClients[roomId].filter((id) => id !== clientId);
  send(ws, { type: "all-users", users: others });
}


function handleSendingSignal(clientId: ClientId,
  msg: Extract<ClientToServerMssg, { type: "sending-signal" }>
): void {
  if (typeof msg.userToSignal !== "string" || !msg.signal) {
    logRejection("sending-signal", clientId, "malformed payload");
    return;
  }


  const roomId = clientIdToRoomId[clientId];
  if (!roomId || !roomIdToClients[roomId]?.includes(msg.userToSignal)) {
    logRejection("sending-signal", clientId, "target not in same room");
    return;
  }

  if (JSON.stringify(msg.signal).length > 65536) {
    logRejection("sending-signal", clientId, "signal payload too large");
    return;
  }

  sendToClient(msg.userToSignal, {
    type: "user-joined",
    signal: msg.signal,
    callerID: clientId, // use verified server-side id, not anything client-claimed
  });
}

function handleReturningSignal(
  clientId: ClientId,
  msg: Extract<ClientToServerMssg, { type: "returning-signal" }>,
): void {
  if (typeof msg.callerID !== "string" || !msg.signal) {
    logRejection("returning-signal", clientId, "malformed payload");
    return;
  }
  const roomId = clientIdToRoomId[clientId];
  if (!roomId || !roomIdToClients[roomId]?.includes(msg.callerID)) {
    logRejection("returning-signal", clientId, "caller not in same room");
    return;
  }
  if (JSON.stringify(msg.signal).length > 65536) {
    logRejection("returning-signal", clientId, "signal payload too large");
    return;
  }

  sendToClient(msg.callerID, {
    type: "receiving-returned-signal",
    signal: msg.signal,
    id: clientId,
  });
}
function removeClient(clientId: ClientId): void {
  const roomId = clientIdToRoomId[clientId];
  if (roomId) {
    const remaining = (roomIdToClients[roomId] || []).filter(
      (id) => id !== clientId,
    );
    if (remaining.length === 0) {
      delete roomIdToClients[roomId];
      delete roomCreatedAt[roomId];
    } else {
      roomIdToClients[roomId] = remaining;
    }
    sendToRoom(roomId, clientId, { type: "user-left", id: clientId });
  }
  delete clientIdToRoomId[clientId];
  delete clientIdToSocket[clientId];
  delete msgCount[clientId];
}

wss.on("connection", (ws) => {
  ws.on("message", (raw: RawData) => {
    let msg: ClientToServerMssg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg.type !== "string") return;

    
    const clientId =
      msg.type === "join-room" ? msg.clientId : socketToClientId.get(ws);
    if (!clientId || typeof clientId !== "string") {
      logRejection(msg.type, "unknown", "message sent before join-room");
      return;
    }

    if (isRateLimited(clientId)) {
      logRejection(msg.type, clientId, "rate limit exceeded");
      return;
    }

    switch (msg.type) {
      case "join-room":
        handleJoinRoom(ws, msg);
        break;
      case "sending-signal":
        handleSendingSignal(clientId, msg);
        break;
      case "returning-signal":
        handleReturningSignal(clientId, msg);
        break;
    }
  });

  ws.on("close", () => {
    const clientId = socketToClientId.get(ws);
    if (!clientId) return; 
    if (clientIdToSocket[clientId] !== ws) return;

    pendingRemoval[clientId] = setTimeout(() => {
      delete pendingRemoval[clientId];
      removeClient(clientId);
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
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);