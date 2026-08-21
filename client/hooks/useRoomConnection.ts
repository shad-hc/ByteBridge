"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getSignalingSocket, disconnectSignalingSocket } from "@/utils/ws";
import {
  createConnection,
  getConnection,
  destroyConnection,
  WebRTCConnection,
} from "@/utils/webrtc";
import type { ServerToClientMessage } from "@/types/signaling";

export type ConnectionStatus =
  | "waiting"
  | "connecting"
  | "connected"
  | "disconnected";

// How long the *answering* side waits for the initiator to send a fresh
// WebRTC offer after a drop, before giving up and showing "Connection
// lost". (The initiating side doesn't need this — it knows immediately
// whether its own re-offer attempt worked.)
const RECONNECT_GRACE_MS = 6000;

// Owns the signaling exchange and the WebRTC connection lifecycle for a
// /share/[roomId] session. Whoever lands on the room first waits
// (non-initiator); the second arrival initiates the handshake.
export function useRoomConnection(
  roomId: string,
  onConnectionReady: (conn: WebRTCConnection, worker: Worker) => void,
) {
  const router = useRouter();
  const workerRef = useRef<Worker | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("waiting");

  // Mirrors connectionStatus so callbacks (timeouts, socket events) can
  // read the latest value instead of a stale one from their closure.
  const statusRef = useRef<ConnectionStatus>("waiting");
  function updateStatus(status: ConnectionStatus) {
    statusRef.current = status;
    setConnectionStatus(status);
  }

  // What we need to re-offer to the same peer if the WebRTC connection
  // (not the signaling socket — see below) drops.
  const peerIdRef = useRef<string | null>(null);
  const isInitiatorRef = useRef(false);
  // Only the side that made the original offer retries, and only once —
  // no exponential backoff, just a single "try again" per drop.
  const reconnectingRef = useRef(false);

  useEffect(() => {
    const worker = new Worker("/worker.js");
    workerRef.current = worker;
    const socket = getSignalingSocket();

    // Attaches our status tracking + a one-shot reconnect to a freshly
    // created WebRTC connection, then hands it to the caller (file
    // transfer / chat hooks) so they can wire up their own message
    // handling.
    function wireConnection(conn: WebRTCConnection) {
      conn.onConnect = () => {
        reconnectingRef.current = false;
        updateStatus("connected");
      };
      conn.onError = () => handleConnectionProblem();
      conn.onClose = () => handleConnectionProblem();
      onConnectionReady(conn, worker);
    }

    // A WebRTC connection can drop for lots of small, temporary reasons (a
    // wifi blip, a brief ICE hiccup). Rather than immediately declaring the
    // session dead, the original initiator gets one shot at silently
    // reconnecting to the same peer — everyone's file-transfer state stays
    // in memory the whole time since neither tab reloads.
    async function handleConnectionProblem() {
      if (reconnectingRef.current) return;

      if (isInitiatorRef.current && peerIdRef.current) {
        reconnectingRef.current = true;
        updateStatus("connecting");
        try {
          await initiateOffer(peerIdRef.current);
        } catch {
          updateStatus("disconnected");
          destroyConnection();
          reconnectingRef.current = false;
        }
        return;
      }

      // We're the answering side: we just wait for the initiator to send a
      // fresh offer ("user-joined" below already knows what to do with
      // it). Give it a few seconds before giving up.
      updateStatus("connecting");
      setTimeout(() => {
        if (statusRef.current !== "connected") {
          updateStatus("disconnected");
          destroyConnection();
        }
      }, RECONNECT_GRACE_MS);
    }

    async function initiateOffer(targetId: string) {
      peerIdRef.current = targetId;
      isInitiatorRef.current = true;
      const conn = createConnection();
      wireConnection(conn);
      const offer = await conn.createOffer();
      // If the signaling socket happens to be mid-reconnect right now,
      // this just waits in its queue instead of getting lost — see
      // utils/ws.ts.
      socket.send({
        type: "sending-signal",
        userToSignal: targetId,
        callerID: socket.clientId,
        signal: offer,
      });
    }

    // We answer when someone joins after us. This also fires again if the
    // initiator silently re-offers after its own WebRTC-level reconnect —
    // same message type, same handler, same flow.
    async function handleUserJoined(
      payload: Extract<ServerToClientMessage, { type: "user-joined" }>,
    ) {
      updateStatus("connecting");
      peerIdRef.current = payload.callerID;
      isInitiatorRef.current = false;
      reconnectingRef.current = false;
      const conn = createConnection();
      wireConnection(conn);
      const answer = await conn.createAnswer(payload.signal);
      socket.send({
        type: "returning-signal",
        callerID: payload.callerID,
        signal: answer,
      });
    }

    socket.onMessage = (msg) => {
      switch (msg.type) {
        case "all-users":
          // Sent only for a genuine fresh join (see server.ts) — a quiet
          // signaling-level reconnect never re-triggers this.
          if (msg.users.length === 0) {
            updateStatus("waiting");
          } else {
            updateStatus("connecting");
            reconnectingRef.current = false;
            initiateOffer(msg.users[0]);
          }
          break;
        case "user-joined":
          handleUserJoined(msg);
          break;
        case "receiving-returned-signal":
          getConnection()?.handleAnswer(msg.signal);
          break;
        case "room-full":
          toast.error("Room is full");
          router.push("/");
          break;
        case "user-left":
          // The other person actually left (closed the tab, their own
          // reconnect attempts ran out) — a real disconnect, not something
          // to retry.
          reconnectingRef.current = false;
          destroyConnection();
          updateStatus("disconnected");
          break;
      }
    };

    // Fires on first connect AND every time the signaling socket silently
    // reconnects — (re)announce ourselves to the room either way. The
    // server recognizes our clientId and treats a fast rejoin as "welcome
    // back" rather than a new participant, so calling this repeatedly is
    // safe and doesn't disturb an already-working WebRTC connection.
    socket.onOpen = () => {
      socket.send({ type: "join-room", roomId, clientId: socket.clientId });
    };

    // The signaling socket dropped and utils/ws.ts is quietly retrying in
    // the background. If our actual peer-to-peer connection is still open,
    // there's nothing to show the user — a signaling hiccup shouldn't
    // interrupt a file transfer that's working fine on its own. Otherwise,
    // reflect that we're reconnecting.
    socket.onClose = () => {
      const stillConnected = getConnection()?.dataChannel?.readyState === "open";
      if (!stillConnected) updateStatus("connecting");
    };

    // Reconnect attempts on the signaling socket are exhausted — same
    // "don't interrupt a working transfer" check as above, otherwise this
    // is a real disconnect.
    socket.onGiveUp = () => {
      const stillConnected = getConnection()?.dataChannel?.readyState === "open";
      if (!stillConnected) {
        updateStatus("disconnected");
        destroyConnection();
      }
    };

    socket.connect();

    return () => {
      socket.onMessage = null;
      socket.onOpen = null;
      socket.onClose = null;
      socket.onGiveUp = null;
      worker.terminate();
      disconnectSignalingSocket();
      destroyConnection();
    };
    // Connection setup runs once on mount; roomId is fixed per page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { connectionStatus, workerRef };
}
