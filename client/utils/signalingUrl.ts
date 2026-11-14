// Single source of truth for the signaling server address.
// NEXT_PUBLIC_SIGNALING_URL may be given as ws(s):// or http(s)://; we derive
// the right scheme for WebSocket vs. HTTP (fetch) use from it.

function rawSignalingUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SIGNALING_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  // Fall back to the host the page was loaded from, so other devices on the
  // LAN reach the server instead of their own "localhost".
  const host =
    typeof window !== "undefined" ? window.location.hostname : "localhost";
  return `ws://${host}:8000`;
}

export function getSignalingWsUrl(): string {
  return rawSignalingUrl().replace(/^http(s?):\/\//, "ws$1://");
}

export function getSignalingHttpUrl(): string {
  return rawSignalingUrl().replace(/^ws(s?):\/\//, "http$1://");
}
