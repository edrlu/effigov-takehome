"use client";

/**
 * One websocket for the whole tab, speaking wire contract v1.
 *
 * The socket lives in a module-level singleton, so every component that calls
 * `useLiveEvents` shares the same connection and simply registers callbacks for
 * the frame types it cares about.
 *
 * Three things make the stream trustworthy rather than merely live:
 *
 * - **Cursor.** Every data frame carries a strictly increasing, gap-free `seq`.
 *   We remember the last one we applied, reconnect with `?since=<seq>`, and
 *   drop any frame whose `seq` is not greater than it, so a replayed frame is
 *   idempotent.
 * - **Resync gate.** When the server says our cursor is unusable (`hello` with
 *   `resume: false`) or that we fell behind (`resync_required`), local state is
 *   wrong, not merely stale. We hold incoming frames in a buffer, ask every
 *   subscriber to refetch its REST snapshot, and only then flush the buffer in
 *   `seq` order. Without the gate a frame that lands mid-refetch would be
 *   overwritten by the older snapshot it raced.
 * - **Honest status.** `connecting` / `catching-up` / `live` / `reconnecting`
 *   are distinct, and while the socket is down we keep the timestamp of the
 *   last frame we applied so the UI can say how stale it is.
 */

import { useEffect, useRef, useState } from "react";
import type { Call, Case, CaseEvent, Report, TranscriptDelta, Turn } from "./types";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";

export type LiveMessage =
  | { type: "case.created"; payload: Case }
  | { type: "case.updated"; payload: { case: Case; changed: string[] } }
  | { type: "case.escalated"; payload: Case }
  | {
      type: "report.filed";
      payload: {
        report: Report;
        case: Case;
        /** Folded onto a case the city already had, rather than opening one. */
        merged: boolean;
        /**
         * This number already had a report on the case: their own account was
         * replaced, and the count of distinct residents did not move.
         */
        repeat?: boolean;
        similarity: number;
      };
    }
  | { type: "report.updated"; payload: { report: Report; case_id: number; changed: string[] } }
  | { type: "call.started"; payload: Call }
  | { type: "call.updated"; payload: { call: Call; changed: string[] } }
  | { type: "transcript.turn"; payload: Turn }
  | { type: "transcript.delta"; payload: TranscriptDelta }
  | { type: "event.appended"; payload: CaseEvent };

export type LiveType = LiveMessage["type"];

type PayloadOf<T extends LiveType> = Extract<LiveMessage, { type: T }>["payload"];

export type LiveHandlers = { [T in LiveType]?: (payload: PayloadOf<T>) => void };

/** A subscriber's REST refetch. The gate waits on the returned promise. */
export type ResyncHandler = () => void | Promise<unknown>;

export type LiveStatus = "connecting" | "catching-up" | "live" | "reconnecting";

export interface LiveState {
  status: LiveStatus;
  /** Last `seq` this tab applied, or null before the first data frame. */
  lastSeq: number | null;
  /** When the last frame was applied, so the UI can show how stale we are. */
  lastFrameAt: number | null;
  /** When the socket went down, or null while connected. */
  downSince: number | null;
}

interface Envelope {
  v: number;
  seq: number | null;
  ts: string;
  type: string;
  payload: unknown;
}

type RawListener = (payload: unknown) => void;

const MAX_BACKOFF_MS = 8_000;
const PING_INTERVAL_MS = 20_000;
/** No pong and no frame for this long means the socket is wedged, not quiet. */
const HEARTBEAT_TIMEOUT_MS = 45_000;
/** A refetch that never settles must not hold the stream hostage forever. */
const RESYNC_TIMEOUT_MS = 10_000;
/** Past this the buffer is worse than another resync round. */
const MAX_BUFFERED_FRAMES = 2_000;
/** Replay should not outlive the socket; flip to `live` rather than lie. */
const CATCHING_UP_TIMEOUT_MS = 15_000;
/**
 * `hello` is the server's first frame, always. A socket that opens and then
 * says nothing contract-shaped is not a live feed, however healthy the TCP
 * connection looks, so give up on it rather than sit on "Catching up".
 */
const HELLO_TIMEOUT_MS = 6_000;

const CONTROL_TYPES = new Set(["hello", "pong", "resync_required"]);

function withSince(url: string, since: number | null): string {
  if (since === null) return url;
  return `${url}${url.includes("?") ? "&" : "?"}since=${since}`;
}

class LiveSocket {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<RawListener>>();
  private stateListeners = new Set<(state: LiveState) => void>();
  private resyncListeners = new Set<ResyncHandler>();

  private state: LiveState = { status: "connecting", lastSeq: null, lastFrameAt: null, downSince: null };

  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeardAt = 0;
  private bound = false;

  /** Highest `seq` the current replay window will deliver, while catching up. */
  private replayTo: number | null = null;

  private gated = false;
  private buffer: Envelope[] = [];

  getState(): LiveState {
    return this.state;
  }

  onState(listener: (state: LiveState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onResync(listener: ResyncHandler): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
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

  /** Used by the connection indicator: stop waiting out the backoff. */
  retryNow(): void {
    this.reconnectNow(true);
  }

  private bindWindowEvents(): void {
    if (this.bound) return;
    this.bound = true;
    window.addEventListener("online", () => this.reconnectNow(false));
    window.addEventListener("focus", () => this.reconnectNow(false));
  }

  private reconnectNow(force: boolean): void {
    if (!force && this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private patchState(next: Partial<LiveState>): void {
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
      if (this.state[key as keyof LiveState] !== value) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...next };
    for (const listener of [...this.stateListeners]) listener(this.state);
  }

  private connect(): void {
    this.patchState({ status: this.state.lastSeq === null && this.attempt === 0 ? "connecting" : "reconnecting" });

    let socket: WebSocket;
    try {
      socket = new WebSocket(withSince(WS_URL, this.state.lastSeq));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.lastHeardAt = Date.now();
      // Stay honest: `live` is claimed only once `hello` says we are current.
      this.patchState({ status: "catching-up" });
      this.startPing();
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (this.socket === socket) socket.close();
      }, HELLO_TIMEOUT_MS);
    };

    socket.onmessage = (event) => {
      this.lastHeardAt = Date.now();
      let frame: Envelope;
      try {
        frame = JSON.parse(event.data as string) as Envelope;
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || frame.v !== 1 || typeof frame.type !== "string") return;
      this.receive(frame);
    };

    socket.onerror = () => {
      socket.close();
    };

    socket.onclose = () => {
      this.stopPing();
      this.stopCatchUpTimer();
      this.stopHelloTimer();
      if (this.socket !== socket) return;
      this.socket = null;
      this.replayTo = null;
      this.patchState({ status: "reconnecting", downSince: this.state.downSince ?? Date.now() });
      this.scheduleRetry();
    };
  }

  private receive(frame: Envelope): void {
    if (CONTROL_TYPES.has(frame.type)) {
      if (frame.type === "hello") this.handleHello(frame.payload);
      else if (frame.type === "resync_required") this.beginResync();
      return;
    }

    if (typeof frame.seq !== "number") return;
    if (this.state.lastSeq !== null && frame.seq <= this.state.lastSeq) return;

    if (this.gated) {
      this.buffer.push(frame);
      if (this.buffer.length > MAX_BUFFERED_FRAMES) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_FRAMES);
      return;
    }

    this.apply(frame);
  }

  private apply(frame: Envelope): void {
    this.patchState({ lastSeq: frame.seq, lastFrameAt: Date.now(), downSince: null });
    this.dispatch(frame);

    if (this.replayTo !== null && frame.seq !== null && frame.seq >= this.replayTo) {
      this.finishCatchUp();
    }
  }

  private dispatch(frame: Envelope): void {
    const listeners = this.listeners.get(frame.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(frame.payload);
      } catch (error) {
        console.error("live event handler failed", error);
      }
    }
  }

  private stopHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private handleHello(payload: unknown): void {
    // A contract-speaking server on the other end: the connection has earned
    // the backoff reset, and the watchdog can stand down.
    this.stopHelloTimer();
    this.attempt = 0;
    const hello = (payload ?? {}) as { latest_seq?: number; resume?: boolean; from?: number; to?: number };
    const latest = typeof hello.latest_seq === "number" ? hello.latest_seq : null;

    if (hello.resume === true) {
      const to = typeof hello.to === "number" ? hello.to : latest;
      // Nothing to replay: we were already current when we reconnected.
      if (to === null || (this.state.lastSeq !== null && to <= this.state.lastSeq)) {
        this.replayTo = null;
        this.finishCatchUp();
        return;
      }
      this.replayTo = to;
      this.patchState({ status: "catching-up" });
      this.startCatchUpTimer();
      return;
    }

    // resume: false. Our cursor is gone, so local state is wrong, not stale.
    this.replayTo = null;
    this.patchState({ lastSeq: latest });
    this.beginResync();
  }

  private startCatchUpTimer(): void {
    this.stopCatchUpTimer();
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      if (this.replayTo !== null) {
        this.replayTo = null;
        this.finishCatchUp();
      }
    }, CATCHING_UP_TIMEOUT_MS);
  }

  private stopCatchUpTimer(): void {
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }

  private finishCatchUp(): void {
    this.replayTo = null;
    this.stopCatchUpTimer();
    if (this.gated) return;
    this.patchState({ status: "live", downSince: null });
  }

  /**
   * Hold the stream, let every subscriber rebuild from REST, then replay what
   * arrived meanwhile. Re-entrant: a second trigger during a round is absorbed.
   */
  private beginResync(): void {
    if (this.gated) return;
    this.gated = true;
    this.patchState({ status: "catching-up" });

    const handlers = [...this.resyncListeners];
    const settled = Promise.allSettled(
      handlers.map((handler) => {
        try {
          return Promise.resolve(handler());
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    const timeout = new Promise((resolve) => setTimeout(resolve, RESYNC_TIMEOUT_MS));

    void Promise.race([settled, timeout]).then(() => this.flush());
  }

  private flush(): void {
    this.gated = false;
    const frames = this.buffer.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    this.buffer = [];
    for (const frame of frames) {
      if (frame.seq === null) continue;
      if (this.state.lastSeq !== null && frame.seq <= this.state.lastSeq) continue;
      this.apply(frame);
    }
    if (this.replayTo === null && this.socket?.readyState === WebSocket.OPEN) {
      this.patchState({ status: "live", downSince: null });
    }
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

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return;
      // A socket that stopped answering looks identical to a quiet one until
      // we ask; treat silence past the timeout as a dead connection.
      if (Date.now() - this.lastHeardAt > HEARTBEAT_TIMEOUT_MS) {
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export const liveSocket = new LiveSocket();

/**
 * Subscribe to the live stream.
 *
 * `handlers` may change between renders; the subscription is registered once,
 * for the frame types present on the first render. `onResync` is called when
 * the server tells us our local state is unusable - refetch REST snapshots and
 * return the promise, so the socket can hold new frames until you are current.
 */
export function useLiveEvents(handlers: LiveHandlers, onResync?: ResyncHandler): LiveState {
  const handlersRef = useRef(handlers);
  const resyncRef = useRef(onResync);
  const typesRef = useRef<LiveType[] | null>(null);
  if (typesRef.current === null) {
    typesRef.current = Object.keys(handlers) as LiveType[];
  }

  const [state, setState] = useState<LiveState>(() => liveSocket.getState());

  useEffect(() => {
    handlersRef.current = handlers;
    resyncRef.current = onResync;
  });

  useEffect(() => {
    const unsubscribes = (typesRef.current ?? []).map((type) =>
      liveSocket.on(type, (payload) => {
        const handler = handlersRef.current[type] as ((value: unknown) => void) | undefined;
        handler?.(payload);
      }),
    );
    unsubscribes.push(liveSocket.onState(setState));
    unsubscribes.push(liveSocket.onResync(() => resyncRef.current?.()));
    liveSocket.ensureConnected();
    setState(liveSocket.getState());
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);

  return state;
}
