"use client";

import { ConnectionState } from "livekit-client";
import { useState, type ReactNode } from "react";
import { CardHeading, ConsoleCard } from "@/components/call/surface";
import { ChevronIcon, EndCallIcon, KeypadIcon, MicIcon, MicOffIcon, PauseIcon } from "@/components/call/icons";
import { useCallSession } from "@/components/call/session";
import { Waveform } from "@/components/call/Waveform";
import { formatDuration, parseServerTime } from "@/lib/time";
import type { Call } from "@/lib/types";
import { useNow } from "@/lib/useNow";

const CONNECTION_COPY: Record<string, { label: string; dot: string; text: string }> = {
  [ConnectionState.Connecting]: { label: "Connecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.Connected]: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-600" },
  [ConnectionState.Reconnecting]: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.SignalReconnecting]: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.Disconnected]: { label: "Disconnected", dot: "bg-slate-300", text: "text-slate-500" },
};

export function CallControls({ call }: { call: Call | null }) {
  const session = useCallSession();
  const [open, setOpen] = useState(true);
  const now = useNow(1000);

  const inSession = session.room !== null;
  const callLive = call !== null && call.status === "active";
  // Our own leg of the call is the honest source when there is one; with no
  // session of our own the card reports the call it is watching.
  const status = inSession
    ? (CONNECTION_COPY[session.connection] ?? CONNECTION_COPY[ConnectionState.Disconnected])
    : callLive
      ? { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-600" }
      : call
        ? { label: "Call ended", dot: "bg-slate-400", text: "text-slate-600" }
        : { label: "No active call", dot: "bg-slate-300", text: "text-slate-500" };

  const audioLive = (inSession && session.connected && session.micEnabled) || false;
  // A finished call must stop counting, so freeze the clock at `ended_at`.
  const until = call?.ended_at ? parseServerTime(call.ended_at).getTime() : now;
  const duration = call ? formatDuration(call.started_at, until) : null;

  return (
    <ConsoleCard className="px-5 py-[18px]">
      <CardHeading
        title="Call Controls"
        action={
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            aria-label={open ? "Collapse call controls" : "Expand call controls"}
            className="-mr-1 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <ChevronIcon className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} />
          </button>
        }
      />

      {open ? (
        <div className="mt-4">
          <dl className="space-y-3">
            <Row label="Call status">
              <span className={`flex items-center gap-2 text-[13px] font-medium ${status.text}`}>
                <span aria-hidden className={`h-[7px] w-[7px] rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </Row>
            <Row label="Call duration">
              <span className="text-[22px] leading-6 font-semibold tracking-[-0.02em] tabular-nums text-slate-900">
                {duration ?? "00:00"}
              </span>
            </Row>
          </dl>

          <div className="mt-4 border-y border-slate-100 py-3">
            <Waveform live={audioLive} />
          </div>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-slate-500">
            {audioLive ? <MicIcon className="h-3.5 w-3.5" /> : <MicOffIcon className="h-3.5 w-3.5" />}
            {inSession
              ? session.micEnabled
                ? "Agent voice active"
                : "Microphone muted"
              : "Start a call to speak to the agent"}
          </p>

          <div className="mt-4 grid grid-cols-4 gap-2">
            <ControlButton
              label={session.micEnabled ? "Mute" : "Unmute"}
              icon={session.micEnabled ? <MicIcon className="h-[18px] w-[18px]" /> : <MicOffIcon className="h-[18px] w-[18px]" />}
              onClick={session.toggleMute}
              disabled={!session.connected}
              active={inSession && !session.micEnabled}
              title={session.connected ? undefined : "Available once you are connected to a call"}
            />
            <ControlButton
              label="Hold"
              icon={<PauseIcon className="h-[18px] w-[18px]" />}
              disabled
              title="Hold is not wired up in this demo"
            />
            <ControlButton
              label="Keypad"
              icon={<KeypadIcon className="h-[18px] w-[18px]" />}
              disabled
              title="The keypad is not wired up in this demo"
            />
            <ControlButton
              label="End call"
              icon={<EndCallIcon className="h-[18px] w-[18px]" />}
              onClick={session.end}
              disabled={!inSession}
              danger
              title={inSession ? undefined : "No call in progress"}
            />
          </div>
        </div>
      ) : null}
    </ConsoleCard>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[13px] text-slate-500">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function ControlButton({
  label,
  icon,
  onClick,
  disabled = false,
  danger = false,
  active = false,
  title,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  title?: string;
}) {
  const tone = danger
    ? "border-red-500 bg-red-500 text-white hover:bg-red-600 hover:border-red-600"
    : active
      ? "border-amber-300 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-[62px] flex-col items-center justify-center gap-1.5 rounded-[10px] border text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-inherit ${tone}`}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
}
