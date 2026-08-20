"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { showSaveFilePicker } from "native-file-system-adapter";
import { getConnection, WebRTCConnection } from "@/utils/webrtc";
import type { DataMessage } from "@/types/signaling";

const CHUNK_SIZE = 64 * 1024;
const BUFFER_THRESHOLD = 1 * 1024 * 1024;
const MAX_SIZE = 1 * 1024 * 1024 * 1024;


export function useFileTransfer() {
  const [files, setFiles] = useState<File[]>([]);
  const [fileProgress, setFileProgress] = useState<Record<number, number>>(
    {},
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [isSendingAll, setIsSendingAll] = useState(false);
  const stopSendAllRef = useRef(false);

  const [receiveProgress, setReceiveProgress] = useState<number | null>(null);
  const [receivingFileName, setReceivingFileName] = useState("");
 
  const [isResuming, setIsResuming] = useState(false);
  const receiveRef = useRef<{ total: number; received: number; fileId: string }>(
    { total: 0, received: 0, fileId: "" },
  );
  const [receivedFiles, setReceivedFiles] = useState<
    { name: string; blob: Blob }[]
  >([]);


  const activeSendRef = useRef<{
    fileId: string;
    resumeResolver: ((offset: number) => void) | null;
  } | null>(null);

  
  function attachToPeer(
    conn: WebRTCConnection,
    worker: Worker,
    onText: (text: string) => void,
  ) {
    const previousOnConnect = conn.onConnect;
    conn.onConnect = () => {
      previousOnConnect?.();
      const r = receiveRef.current;
      if (r.fileId && r.received < r.total) {
        setIsResuming(true);
        const msg: DataMessage = {
          type: "resume-request",
          fileId: r.fileId,
          receivedBytes: r.received,
        };
        conn.send(JSON.stringify(msg));
      }
    };

    conn.onData = (data) => {
      if (typeof data === "string") {
        const parsed = JSON.parse(data) as DataMessage;
        handleControlMessage(parsed, conn, worker, onText);
        return;
      }

     
      const r = receiveRef.current;
      if (r.total > 0) {
        r.received += data.byteLength;
        setReceiveProgress(
          Math.min(100, Math.round((r.received / r.total) * 100)),
        );
      }
      setIsResuming(false);
      worker.postMessage(data, [data]);
    };
  }

  function handleControlMessage(
    parsed: DataMessage,
    conn: WebRTCConnection,
    worker: Worker,
    onText: (text: string) => void,
  ) {
    switch (parsed.type) {
      case "file-start": {
        receiveRef.current = {
          total: parsed.size,
          received: 0,
          fileId: parsed.fileId,
        };
        setReceivingFileName(parsed.fileName);
        setReceiveProgress(0);
        setIsResuming(false);
        break;
      }

      case "file-done": {
        setReceiveProgress(null);
        setIsResuming(false);
        receiveRef.current = { total: 0, received: 0, fileId: "" };
        const fileName = parsed.fileName;
        worker.postMessage("download");
        worker.addEventListener(
          "message",
          (event: MessageEvent<Blob>) => {
            setReceivedFiles((prev) => [
              ...prev,
              { name: fileName, blob: event.data },
            ]);
          },
          { once: true },
        );
        break;
      }

      case "text": {
        onText(parsed.text);
        break;
      }

      case "resume-request": {
        if (activeSendRef.current?.fileId === parsed.fileId) {
          const resolve = activeSendRef.current.resumeResolver;
          activeSendRef.current.resumeResolver = null;
          resolve?.(parsed.receivedBytes);
        }
        const response: DataMessage = {
          type: "resume-response",
          fileId: parsed.fileId,
          startOffset: parsed.receivedBytes,
        };
        conn.send(JSON.stringify(response));
        break;
      }
      case "resume-response": {
        setIsResuming(false);
        break;
      }
    }
  }

  async function handleDownload(file: { name: string; blob: Blob }) {
    setReceivedFiles((prev) => prev.filter((f) => f !== file));
    try {
      const handle = await showSaveFilePicker({ suggestedName: file.name });
      const writable = await handle.createWritable();
      await file.blob.stream().pipeTo(writable);
      toast.success(`Saved ${file.name}`);
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    }
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast.success(`Downloaded ${file.name}`);
  }


  function waitForBufferSpace(
    channel: RTCDataChannel,
    abort: AbortController,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;
      const cleanup = () => {
        channel.onbufferedamountlow = null;
        channel.removeEventListener("close", onClosed);
      };
      const onClosed = () => {
        cleanup();
        resolve();
      };
      channel.onbufferedamountlow = () => {
        cleanup();
        resolve();
      };
      channel.addEventListener("close", onClosed, { once: true });
      abort.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }

  function waitForResume(
    fileId: string,
    abort: AbortController,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      if (activeSendRef.current?.fileId === fileId) {
        activeSendRef.current.resumeResolver = resolve;
      }
      abort.signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      );
    });
  }

  async function sendFile(file: File, index: number) {
    const conn = getConnection();
    if (!conn) return;

    if (file.size > MAX_SIZE) {
      toast.error("File too large. Maximum size is 1GB.");
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setActiveIndex(index);
    setFileProgress((prev) => ({ ...prev, [index]: 0 }));

    const fileId = crypto.randomUUID();
    activeSendRef.current = { fileId, resumeResolver: null };
    let offset = 0;

    // Announce the transfer so the receiver can show real progress.
    const startMsg: DataMessage = {
      type: "file-start",
      fileId,
      fileName: file.name,
      size: file.size,
      chunkSize: CHUNK_SIZE,
    };
    conn.send(JSON.stringify(startMsg));

    try {
      while (offset < file.size) {
        if (abort.signal.aborted) {
          toast("Transfer cancelled");
          stopSendAllRef.current = true;
          break;
        }

        const channel = getConnection()?.dataChannel;

        if (!channel || channel.readyState !== "open") {
          offset = await waitForResume(fileId, abort);
          continue;
        }

        if (channel.bufferedAmount >= BUFFER_THRESHOLD) {
          await waitForBufferSpace(channel, abort);
          continue;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();
        getConnection()?.send(buffer);
        offset += CHUNK_SIZE;
        setFileProgress((prev) => ({
          ...prev,
          [index]: Math.min(100, Math.round((offset / file.size) * 100)),
        }));
      }

      if (!abort.signal.aborted) {
        const done: DataMessage = {
          type: "file-done",
          fileId,
          fileName: file.name,
        };
        getConnection()?.send(JSON.stringify(done));
        toast.success(`Sent ${file.name}`);
        setFiles((prev) => prev.filter((_, i) => i !== index));
      }
    } catch {
      // cancelled or error
    } finally {
      activeSendRef.current = null;
      setFileProgress((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      abortRef.current = null;
      setActiveIndex(null);
    }
  }

  async function sendAll() {
    if (isSendingAll) return;
    // Snapshot so additions during the run don't extend the queue.
    const snapshot = [...files];
    if (snapshot.length === 0) return;
    setIsSendingAll(true);
    stopSendAllRef.current = false;
    for (const file of snapshot) {
      if (stopSendAllRef.current) break;
      await sendFile(file, 0);
      if (abortRef.current === null && stopSendAllRef.current) break;
    }
    setIsSendingAll(false);
    stopSendAllRef.current = false;
  }

  function cancelAll() {
    stopSendAllRef.current = true;
    abortRef.current?.abort();
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    const selectedFiles = e.target.files;
    if (selectedFiles)
      setFiles((prev) => [...prev, ...Array.from(selectedFiles)]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files)
      setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return {
    files,
    fileProgress,
    activeIndex,
    abortRef,
    isSendingAll,
    receiveProgress,
    receivingFileName,
    isResuming,
    receivedFiles,
    attachToPeer,
    handleDownload,
    sendFile,
    sendAll,
    cancelAll,
    handleFileSelect,
    handleDrop,
    removeFile,
  };
}
