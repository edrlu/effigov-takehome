"use client";

import {
  BarVisualizer,
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { ConnectionState } from "livekit-client";
import Link from "next/link";
import { useState } from "react";
import { ErrorNote } from "@/components/ui";
import { api } from "@/lib/api";
import type { TokenResponse } from "@/lib/types";

const CONNECTION_COPY: Record<string, { label: string; dot: string; text: string; pulse: boolean }> = {
  [ConnectionState.Connecting]: { label: "Connecting", dot: "bg-amber-400", text: "text-amber-300", pulse: false },
  [ConnectionState.Connected]: { label: "Connected", dot: "bg-green-400", text: "text-green-300", pulse: true },
  [ConnectionState.Reconnecting]: {
    label: "Reconnecting",
    dot: "bg-amber-400",
    text: "text-amber-300",
    pulse: false,
  },
  [ConnectionState.SignalReconnecting]: {
    label: "Reconnecting",
    dot: "bg-amber-400",
    text: "text-amber-300",
    pulse: false,
  },
  [ConnectionState.Disconnected]: { label: "Disconnected", dot: "bg-faint", text: "text-faint", pulse: false },
};

const AGENT_COPY: Record<string, string> = {
  disconnected: "Waiting for an agent to join",
  connecting: "Agent is joining",
  initializing: "Agent is warming up",
  listening: "Agent is listening",
  thinking: "Agent is thinking",
  speaking: "Agent is speaking",
};

export default function ResidentCallPage() {
  const [session, setSession] = useState<TokenResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setSession(await api.createToken({}));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the call");
    } finally {
      setStarting(false);
    }
  };

  const end = () => setSession(null);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4">
      <div>
        <h1 className="text-[20px] leading-7 font-semibold tracking-tight">Report a problem by voice</h1>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Talk to the city intake agent. It files the service request while you speak, and staff see it land on the
          dashboard in real time.
        </p>
      </div>

      {error ? <ErrorNote message={error} onRetry={() => void start()} /> : null}

      {!session ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-panel px-6 py-12 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full border border-line-strong bg-raised">
            <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6 text-accent" fill="currentColor">
              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2Z" />
            </svg>
          </span>
          <div>
            <p className="text-[14px] font-medium">Microphone only</p>
            <p className="mt-1 text-[12px] text-faint">Your browser will ask for microphone access.</p>
          </div>
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            className="h-9 rounded-md bg-accent px-4 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? "Starting" : "Start a call"}
          </button>
        </div>
      ) : (
        <LiveKitRoom
          token={session.token}
          serverUrl={session.url}
          connect
          audio
          video={false}
          onDisconnected={end}
          onError={(cause) => {
            setError(
              `${cause.message}. Check that the LiveKit server at ${session.url} is running (livekit-server --dev).`,
            );
            setSession(null);
          }}
          className="contents"
        >
          <RoomAudioRenderer />
          <CallStage session={session} />
        </LiveKitRoom>
      )}

      <p className="text-center text-[12px] text-faint">
        Staff view:{" "}
        <Link href="/" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-ink">
          the case queue
        </Link>
      </p>
    </div>
  );
}

function CallStage({ session }: { session: TokenResponse }) {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const { state: agentState, audioTrack } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();

  const connection = CONNECTION_COPY[connectionState] ?? CONNECTION_COPY[ConnectionState.Disconnected];
  const connected = connectionState === ConnectionState.Connected;
  const visualizerTrack = audioTrack ?? undefined;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[12px]">
          <span className={`h-1.5 w-1.5 rounded-full ${connection.dot} ${connection.pulse ? "live-dot" : ""}`} />
          <span className={connection.text}>{connection.label}</span>
        </span>
        <span className="truncate font-mono text-[12px] text-faint">{session.room}</span>
      </div>

      <div className="flex h-24 items-center justify-center rounded-md border border-line bg-canvas">
        {visualizerTrack ? (
          <BarVisualizer
            state={agentState}
            barCount={7}
            track={visualizerTrack}
            options={{ minHeight: 12 }}
            className="flex h-12 items-center justify-center gap-1.5"
          >
            <span className="w-1.5 rounded-full bg-accent/40 data-[lk-highlighted=true]:bg-accent" />
          </BarVisualizer>
        ) : (
          <div className="flex h-12 items-end justify-center gap-1.5" aria-hidden>
            {Array.from({ length: 7 }).map((_, index) => (
              <span key={index} className="w-1.5 rounded-full bg-line-strong" style={{ height: 12 }} />
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[12px] text-muted">
        {connected ? (AGENT_COPY[agentState] ?? "In call") : "Setting up the room"}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
          disabled={!connected}
          className={`h-9 rounded-md border px-3.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            isMicrophoneEnabled
              ? "border-line text-ink hover:border-line-strong"
              : "border-amber-400/40 bg-amber-400/10 text-amber-300"
          }`}
        >
          {isMicrophoneEnabled ? "Mute" : "Unmute"}
        </button>
        <button
          type="button"
          onClick={() => void room.disconnect()}
          className="h-9 rounded-md bg-red-500/90 px-3.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
        >
          End call
        </button>
      </div>

      {microphoneTrack === undefined && connected ? (
        <p className="text-center text-[12px] text-amber-300">
          No microphone is publishing yet. Allow microphone access to be heard.
        </p>
      ) : null}
    </div>
  );
}
