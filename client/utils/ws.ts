import type { ClientToServerMessage,ServerToClientMessage } from "@/types/signaling"; 


const url = process.env.NEXT_SIGNALING_URL || "ws://localhost:8000";

const RECONNECT_DELAY_MS = 1000; // 1s
const MAX_RECONNECT_DELAY_MS = 5000; // 5s

export class SignalingSocket {
  readonly clientId = crypto.randomUUID();
  private url: string;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private intentionalClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;


  private queue: ClientToServerMessage[] = [];

  onOpen: (() => void) | null = null;
  onMessage: ((msg: ServerToClientMessage) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
      // Keep retrying for as long as the page is open, so a room recovers on
      // its own once the server is back.
      const delay = Math.min(
        RECONNECT_DELAY_MS * 2 ** this.attempts,
        MAX_RECONNECT_DELAY_MS,
      );
      this.attempts++;
      this.onClose?.();
      this.retryTimer = setTimeout(() => this.connect(), delay);
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
