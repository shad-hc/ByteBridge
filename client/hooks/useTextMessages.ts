"use client";

import { useEffect, useRef, useState } from "react";
import { getConnection } from "@/utils/webrtc";
import type { DataMessage } from "@/types/signaling";

// Owns the chat transcript and outgoing message composition for a peer
// data channel. Incoming text frames are pushed in via addIncoming, which
// the data-channel consumer (useFileTransfer's attachToPeer) calls when it
// sees a { type: "text" } frame.
export function useTextMessages() {
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function addIncoming(text: string) {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        text,
        timestamp: new Date().toLocaleTimeString(),
        fromSelf: false,
      },
    ]);
  }

  function handleSendMessage() {
    const text = messageText.trim();
    if (!text) return;
    const conn = getConnection();
    if (!conn) return;

    const msg: DataMessage = { type: "text", text };
    conn.send(JSON.stringify(msg));
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        text,
        timestamp: new Date().toLocaleTimeString(),
        fromSelf: true,
      },
    ]);
    setMessageText("");
  }

  return {
    messages,
    messageText,
    setMessageText,
    handleSendMessage,
    addIncoming,
    messagesEndRef,
  };
}
