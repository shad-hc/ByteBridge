import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";


const redis = new Redis(REDIS_URL);
const redisSub = new Redis(REDIS_URL);
redis.on("error", (err) => console.error("Redis error:", err.message));
redisSub.on("error", (err) =>
  console.error("Redis (subscriber) error:", err.message),
);


function roomKey(roomId: string): string {
  return `room:${roomId}`;
}
function ownerKey(clientId: string): string {
  return `owner:${clientId}`;
}


const ROOM_TTL_SECONDS = 3600;


export async function addClientToRoom(
  roomId: string,
  clientId: string,
): Promise<void> {
  await redis.sadd(roomKey(roomId), clientId);
  await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
}

export async function removeClientFromRoom(
  roomId: string,
  clientId: string,
): Promise<void> {
  await redis.srem(roomKey(roomId), clientId);
  const remaining = await redis.scard(roomKey(roomId));
  if (remaining === 0) await redis.del(roomKey(roomId));
}

export async function isClientInRoom(
  roomId: string,
  clientId: string,
): Promise<boolean> {
  const result = await redis.sismember(roomKey(roomId), clientId);
  return result === 1;
}

export async function getRoomMembers(roomId: string): Promise<string[]> {
  return redis.smembers(roomKey(roomId));
}

export async function getRoomSize(roomId: string): Promise<number> {
  return redis.scard(roomKey(roomId));
}


export async function refreshRoomTtl(roomId: string): Promise<void> {
  await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
}


export async function setOwnerToken(
  clientId: string,
  token: string,
): Promise<void> {
  await redis.set(ownerKey(clientId), token);
}

export async function getOwnerToken(clientId: string): Promise<string | null> {
  return redis.get(ownerKey(clientId));
}

export async function clearOwnerToken(clientId: string): Promise<void> {
  await redis.del(ownerKey(clientId));
}

const SIGNAL_CHANNEL = "signaling";

export async function publishToClient<T>(
  clientId: string,
  payload: T,
): Promise<void> {
  const relay = { targetClientId: clientId, payload };
  await redis.publish(SIGNAL_CHANNEL, JSON.stringify(relay));
}

export async function sendToRoom<T>(
  roomId: string,
  exceptClientId: string,
  payload: T,
): Promise<void> {
  const members = await getRoomMembers(roomId);
  await Promise.all(
    members
      .filter((id) => id !== exceptClientId)
      .map((id) => publishToClient(id, payload)),
  );
}

export function subscribeToChannel<T>(
  onMessage: (targetClientId: string, payload: T) => void,
): void {
  redisSub.subscribe(SIGNAL_CHANNEL).catch((err) => {
    console.error("Failed to subscribe to Redis channel:", err.message);
  });

  redisSub.on("message", (_channel, raw) => {
    let relay: { targetClientId: string; payload: T };
    try {
      relay = JSON.parse(raw);
    } catch {
      return;
    }
    onMessage(relay.targetClientId, relay.payload);
  });
}

export function disconnectRedis(): void {
  redis.disconnect();
  redisSub.disconnect();
}
