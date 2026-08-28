"use client";

/**
 * One websocket for the whole tab.
 *
 * The socket lives in a module-level singleton, so every component that calls
 * `useLiveEvents` shares the same connection and simply registers callbacks for
 * the message types it cares about. Reconnects use exponential backoff with
 * jitter, and a retry is forced as soon as the tab comes back online.
 */

import { useEffect, useRef, useState } from "react";
import type { Call, Case, Report, Turn } from "./types";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";

export type LiveMessage =
  | { type: "case.created"; payload: Case }
  | { type: "case.updated"; payload: { case: Case; changed: string[] } }
  | { type: "call.started"; payload: Call }
  | { type: "call.updated"; payload: Call }
  | { type: "transcript.turn"; payload: Turn }
  | { type: "report.filed"; payload: { report: Report; case: Case; merged: boolean } }
  | { type: "case.escalated"; payload: Case };

export type LiveType = LiveMessage["type"];

type PayloadOf<T extends LiveType> = Extract<LiveMessage, { type: T }>["payload"];

export type LiveHandlers = { [T in LiveType]?: (payload: PayloadOf<T>) => void };

export type LiveStatus = "connecting" | "live" | "reconnecting";

type RawListener = (payload: unknown) => void;

const MAX_BACKOFF_MS = 8_000;
const PING_INTERVAL_MS = 25_000;

class LiveSocket {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<RawListener>>();
  private statusListeners = new Set<(status: LiveStatus) => void>();
  private status: LiveStatus = "connecting";
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private bound = false;

  getStatus(): LiveStatus {
    return this.status;
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  on<T extends LiveType>(type: T, listener: (payload: PayloadOf<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set<RawListener>();
    set.add(listener as RawListener);
    this.listeners.set(type, set);
    this.ensureConnected();
    return () => {
      set.delete(listener as RawListener);
    };
  }

  ensureConnected(): void {
    if (typeof window === "undefined") return;
    this.bindWindowEvents();
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect();
  }

  private bindWindowEvents(): void {
    if (this.bound) return;
    this.bound = true;
    window.addEventListener("online", () => this.reconnectNow());
    window.addEventListener("focus", () => this.reconnectNow());
  }

  private reconnectNow(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private setStatus(status: LiveStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private connect(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("live");
      this.startPing();
    };

    socket.onmessage = (event) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(event.data as string) as LiveMessage;
      } catch {
        return;
      }
      const listeners = this.listeners.get(message.type);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(message.payload);
        } catch (error) {
          console.error("live event handler failed", error);
        }
      }
    };

    socket.onerror = () => {
      socket.close();
    };

    socket.onclose = () => {
      this.stopPing();
      if (this.socket === socket) this.socket = null;
      this.setStatus("reconnecting");
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = Math.min(500 * 2 ** this.attempt, MAX_BACKOFF_MS) + Math.random() * 250;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** The server drains anything we send; this only keeps the socket warm. */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send("ping");
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export const liveSocket = new LiveSocket();

/**
 * Subscribe to live case/call events. Handlers may change between renders; the
 * subscription itself is registered once, for the message types present on the
 * first render.
 */
export function useLiveEvents(handlers: LiveHandlers): { status: LiveStatus } {
  const handlersRef = useRef(handlers);
  const typesRef = useRef<LiveType[] | null>(null);
  if (typesRef.current === null) {
    typesRef.current = Object.keys(handlers) as LiveType[];
  }

  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const unsubscribes = (typesRef.current ?? []).map((type) =>
      liveSocket.on(type, (payload) => {
        const handler = handlersRef.current[type] as ((value: unknown) => void) | undefined;
        handler?.(payload);
      }),
    );
    unsubscribes.push(liveSocket.onStatus(setStatus));
    liveSocket.ensureConnected();
    setStatus(liveSocket.getStatus());
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);

  return { status };
}
