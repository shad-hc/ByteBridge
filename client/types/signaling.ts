export type ClientToServerMessage =
  | { type: "join-room"; roomId: string; clientId: string }
  | {
      type: "sending-signal";
      userToSignal: string;
      callerID: string;
      signal: RTCSessionDescriptionInit;
    }
  | {
      type: "returning-signal";
      callerID: string;
      signal: RTCSessionDescriptionInit;
    };

export type ServerToClientMessage =
  | { type: "all-users"; users: string[] }
  | { type: "user-joined"; signal: RTCSessionDescriptionInit; callerID: string }
  | { type: "receiving-returned-signal"; signal: RTCSessionDescriptionInit; id: string }
  | { type: "room-full" }
  | { type: "user-left"; id: string };

export type DataMessage =
  | { type: "text"; text: string }
  | {
      type: "file-start";
      fileId: string;
      fileName: string;
      size: number;
      chunkSize: number;
    }
  | { type: "resume-request"; fileId: string; receivedBytes: number }
  | { type: "resume-response"; fileId: string; startOffset: number }
  | { type: "file-done"; fileId: string; fileName: string };
