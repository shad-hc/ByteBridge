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


const RECONNECT_GRACE_MS = 6000;

export function useRoomConnection(
  roomId: string,
  onConnectionReady: (conn: WebRTCConnection, worker: Worker) => void,
) {
  const router = useRouter();
  const workerRef = useRef<Worker | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("waiting");
  const statusRef = useRef<ConnectionStatus>("waiting");
  function updateStatus(status: ConnectionStatus) {
    statusRef.current = status;
    setConnectionStatus(status);
  }

  
  const peerIdRef = useRef<string | null>(null);
  const isInitiatorRef = useRef(false);
  
   const reconnectingRef = useRef(false);

  useEffect(() => {
    const worker = new Worker("/worker.js");
    workerRef.current = worker;
    const socket = getSignalingSocket();

   
    function wireConnection(conn: WebRTCConnection) {
      conn.onConnect = () => {
        reconnectingRef.current = false;
        updateStatus("connected");
      };
      conn.onError = () => handleConnectionProblem();
      conn.onClose = () => handleConnectionProblem();
      onConnectionReady(conn, worker);
    }


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

      socket.send({
        type: "sending-signal",
        userToSignal: targetId,
        callerID: socket.clientId,
        signal: offer,
      });
    }


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
          reconnectingRef.current = false;
          destroyConnection();
          updateStatus("disconnected");
          break;
      }
    };

    socket.onOpen = () => {
      socket.send({ type: "join-room", roomId, clientId: socket.clientId });
    };

 
    socket.onClose = () => {
      const stillConnected = getConnection()?.dataChannel?.readyState === "open";
      if (!stillConnected) updateStatus("connecting");
    };

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
  }, []);

  return { connectionStatus, workerRef };
}
