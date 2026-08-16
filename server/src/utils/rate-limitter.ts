export type ClientId = string;
export const msgCount: Record<string, { count: number; resetAt: number }> = {};
const MAX_MESSAGES = 30;
const RATE_LIMIT_WINDOW_MS = 1000; 

export default function isRateLimited(ClientId : ClientId): boolean {
  const now = Date.now();
  const entry = msgCount[ClientId];
  if (!entry || now > entry.resetAt) {
    msgCount[ClientId] = {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    return false;
  }
  entry.count++;
  return entry.count > MAX_MESSAGES;
}
