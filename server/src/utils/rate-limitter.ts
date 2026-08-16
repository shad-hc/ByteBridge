export type SocketId = string;

export const socketMsgCount: Record<SocketId, { count: number; resetAt: number }> = {};
const MAX_MESSAGES = 30;
const RATE_LIMIT_WINDOW_MS = 1000; 

export default function isRateLimited(socketId: SocketId): boolean {
  const now = Date.now();
  const entry = socketMsgCount[socketId];
  if (!entry || now > entry.resetAt) {
    socketMsgCount[socketId] = {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    return false;
  }
  entry.count++;
  return entry.count > MAX_MESSAGES;
}
