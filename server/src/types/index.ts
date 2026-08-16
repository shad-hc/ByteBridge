export type ClientToServerMssg =
  | { type: "join-room"; roomId: string; clientId: string }
  | {
      type: "sending-signal";
      userToSignal: string;
      callerID: string;
      signal: unknown;
    }
  | { type: "returning-signal"; callerID: string; signal: unknown };


export type ServerToClientMssg =
  | { type: "all-users"; users: string[] }
  | { type: "user-joined"; signal: unknown; callerID: string }
  | { type: "receiving-returned-signal"; signal: unknown; id: string }
  | { type: "room-full" }
  | { type: "user-left"; id: string };
 