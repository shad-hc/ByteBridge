import type { ClientToServerMessage,ServerToClientMessage } from "@/types/signaling"; 


const url = process.env.NEXT_SIGNALING_URL || "ws://localhost:8000";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000; // 1s

export class SignalingSocket {
  readonly clientId = crypto.randomUUID();
  private url: string;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private intentionalClose = false;


  private queue: ClientToServerMessage[] = [];

  onOpen: (() => void) | null = null;
  onMessage: ((msg: ServerToClientMessage) => void) | null = null;
  onClose: (() => void) | null = null;
  onGiveUp: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    this.intentionalClose = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.onOpen?.();
      this.emptyQueue();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerToClientMessage;
        this.onMessage?.(msg);
      } catch {
        // ignore malformed 
      }
    };

    ws.onclose = () => {
      if (this.intentionalClose) return;
      if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
        this.onGiveUp?.();
        return;
      }
      this.attempts++;
      this.onClose?.();
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    };
  }

  private emptyQueue() {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) this.send(msg);
  }

  send(msg: ClientToServerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  close() {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
  }
}

let socket: SignalingSocket | null = null;

export function getSignalingSocket(): SignalingSocket {
  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:8000";
    socket = new SignalingSocket(url);
  }
  return socket;
}

export function disconnectSignalingSocket() {
  socket?.close();
  socket = null;
}
