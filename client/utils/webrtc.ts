const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

if (process.env.NEXT_PUBLIC_TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.NEXT_PUBLIC_TURN_URL,
    username: process.env.NEXT_PUBLIC_TURN_USER || "",
    credential: process.env.NEXT_PUBLIC_TURN_CRED || "",
  });
}


const ICE_GATHERING_TIMEOUT_MS = 3000;

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", check);
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
  });
}

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;

  onConnect: (() => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  onData: ((data: string | ArrayBuffer) => void) | null = null;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") {
        this.onError?.(new Error("WebRTC connection failed"));
      }
    };
  }

  get dataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  private setupChannel(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    this.channel = channel;
    channel.onopen = () => this.onConnect?.();
    channel.onclose = () => this.onClose?.();
    channel.onerror = (event) => this.onError?.(event);
    channel.onmessage = (event) => this.onData?.(event.data);
  }

 
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.setupChannel(this.pc.createDataChannel("data"));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.pc);
    return this.pc.localDescription as RTCSessionDescriptionInit;
  }

  
  async createAnswer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    this.pc.ondatachannel = (event) => this.setupChannel(event.channel);
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(this.pc);
    return this.pc.localDescription as RTCSessionDescriptionInit;
  }

  // Initiator side: apply the receiver's answer to finish the handshake.
  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.channel?.readyState === "open") {
      this.channel.send(data as never);
    }
  }

  close() {
    this.channel?.close();
    this.pc.close();
  }
}


let connection: WebRTCConnection | null = null;

export function createConnection(): WebRTCConnection {
  if (connection) connection.close();
  connection = new WebRTCConnection();
  return connection;
}

export function getConnection(): WebRTCConnection | null {
  return connection;
}

export function destroyConnection() {
  if (connection) {
    connection.close();
    connection = null;
  }
}
