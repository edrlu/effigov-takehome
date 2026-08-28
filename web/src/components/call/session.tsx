"use client";

/**
 * The resident's own leg of the call, lifted out of the LiveKit tree.
 *
 * The console is a three-column layout, but only a couple of leaves need
 * LiveKit: the controls, the waveform, and the volume chip. Rather than nest
 * the whole page inside `LiveKitRoom`, the room renders headless beside the
 * layout and publishes what it knows through this context, so every panel can
 * read the connection without caring where it came from.
 *
 * The live input level deliberately does not travel through React state: it
 * changes every animation frame, and re-rendering the console at 60fps to move
 * a waveform would make the rest of the page stutter. Panels subscribe to the
 * shared `LevelMeter` and write to the DOM themselves.
 */

import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { LevelMeter } from "@/lib/micLevel";
import type { TokenResponse } from "@/lib/types";

export type AgentActivity = "idle" | "listening" | "thinking" | "speaking" | "connecting";

export interface CallSession {
  /** The room this browser is speaking into, or null when not in a call. */
  room: string | null;
  connection: ConnectionState;
  connected: boolean;
  starting: boolean;
  error: string | null;
  micEnabled: boolean;
  micPublished: boolean;
  agent: AgentActivity;
  meter: LevelMeter;
  start: () => void;
  end: () => void;
  toggleMute: () => void;
  dismissError: () => void;
}

const CallSessionContext = createContext<CallSession | null>(null);

export function useCallSession(): CallSession {
  const value = useContext(CallSessionContext);
  if (!value) throw new Error("useCallSession must be used inside CallSessionProvider");
  return value;
}

const AGENT_ACTIVITY: Record<string, AgentActivity> = {
  disconnected: "idle",
  connecting: "connecting",
  initializing: "connecting",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

interface RoomFacts {
  connection: ConnectionState;
  micEnabled: boolean;
  micPublished: boolean;
  agent: AgentActivity;
}

const IDLE_FACTS: RoomFacts = {
  connection: ConnectionState.Disconnected,
  micEnabled: false,
  micPublished: false,
  agent: "idle",
};

export function CallSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<TokenResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facts, setFacts] = useState<RoomFacts>(IDLE_FACTS);

  const meter = useMemo(() => new LevelMeter(), []);
  const controls = useRef<{ disconnect: () => void; setMic: (on: boolean) => void } | null>(null);
  // Read by `toggleMute`, which must not derive the next state inside a
  // `setState` updater: React may run an updater twice.
  const micRef = useRef(false);
  micRef.current = facts.micEnabled;

  useEffect(() => () => meter.dispose(), [meter]);

  const start = useCallback(() => {
    setStarting(true);
    setError(null);
    void api
      .createToken({})
      .then((next) => setSession(next))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not start the call");
      })
      .finally(() => setStarting(false));
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setFacts(IDLE_FACTS);
    meter.setTrack(null);
    controls.current = null;
  }, [meter]);

  const end = useCallback(() => {
    controls.current?.disconnect();
    clearSession();
  }, [clearSession]);

  const toggleMute = useCallback(() => {
    controls.current?.setMic(!micRef.current);
  }, []);

  const value: CallSession = useMemo(
    () => ({
      room: session?.room ?? null,
      connection: facts.connection,
      connected: facts.connection === ConnectionState.Connected,
      starting,
      error,
      micEnabled: facts.micEnabled,
      micPublished: facts.micPublished,
      agent: facts.agent,
      meter,
      start,
      end,
      toggleMute,
      dismissError: () => setError(null),
    }),
    [end, error, facts, meter, session, start, starting, toggleMute],
  );

  return (
    <CallSessionContext.Provider value={value}>
      {session ? (
        <LiveKitRoom
          token={session.token}
          serverUrl={session.url}
          connect
          audio
          video={false}
          onDisconnected={clearSession}
          onError={(cause) => {
            setError(
              `${cause.message}. Check that the LiveKit server at ${session.url} is running (livekit-server --dev).`,
            );
            clearSession();
          }}
          className="contents"
        >
          <RoomAudioRenderer />
          <RoomBridge meter={meter} onFacts={setFacts} controls={controls} />
        </LiveKitRoom>
      ) : null}
      {children}
    </CallSessionContext.Provider>
  );
}

/**
 * Headless: it renders nothing and exists only to copy the room's state out of
 * the LiveKit tree and to hand the console back a way to act on the room.
 */
function RoomBridge({
  meter,
  onFacts,
  controls,
}: {
  meter: LevelMeter;
  onFacts: (facts: RoomFacts) => void;
  controls: { current: { disconnect: () => void; setMic: (on: boolean) => void } | null };
}) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const { state: agentState } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();

  useEffect(() => {
    controls.current = {
      disconnect: () => void room.disconnect(),
      setMic: (on) => void localParticipant.setMicrophoneEnabled(on),
    };
  }, [controls, localParticipant, room]);

  const mediaTrack = microphoneTrack?.track?.mediaStreamTrack ?? null;

  useEffect(() => {
    meter.setTrack(mediaTrack);
  }, [mediaTrack, meter]);

  useEffect(() => {
    onFacts({
      connection,
      micEnabled: isMicrophoneEnabled,
      micPublished: mediaTrack !== null,
      agent: AGENT_ACTIVITY[agentState] ?? "idle",
    });
  }, [agentState, connection, isMicrophoneEnabled, mediaTrack, onFacts]);

  return null;
}
