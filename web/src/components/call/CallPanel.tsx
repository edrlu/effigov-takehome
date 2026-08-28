"use client";

/**
 * Who is on the line, what the agent is doing about it, and what you can do
 * about it - one panel.
 *
 * `Current Call` and `Call Controls` used to be two cards stacked in different
 * columns, which split one conversation across two headers. They are merged
 * here and read top to bottom: the caller, the agent's read on them, the state
 * of the line, and finally the controls.
 *
 * Every block below has a fixed height. The panel must occupy the same
 * rectangle empty as it does mid-call, so nothing on the page moves when a
 * field goes from "not captured yet" to a real value.
 */

import { ConnectionState } from "livekit-client";
import Link from "next/link";
import type { ReactNode } from "react";
import { CardHeading, ConsoleCard, Pill } from "@/components/call/surface";
import {
  EndCallIcon,
  GlobeIcon,
  KeypadIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PeopleIcon,
  PhoneIcon,
  SparkleIcon,
} from "@/components/call/icons";
import { useCallSession } from "@/components/call/session";
import { VolumeMeter, Waveform } from "@/components/call/Waveform";
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_PILL,
  SENTIMENT_LABEL,
  SENTIMENT_PILL,
  activityLine,
  confidenceBand,
  displayPhone,
} from "@/lib/callConsole";
import { formatDuration, parseServerTime } from "@/lib/time";
import type { Call, Case, Report } from "@/lib/types";
import { useNow } from "@/lib/useNow";

const DEFAULT_CITY = "Berkeley, CA";

const CONNECTION_COPY: Record<string, { label: string; dot: string; text: string }> = {
  [ConnectionState.Connecting]: { label: "Connecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.Connected]: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-600" },
  [ConnectionState.Reconnecting]: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.SignalReconnecting]: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-600" },
  [ConnectionState.Disconnected]: { label: "Disconnected", dot: "bg-slate-300", text: "text-slate-500" },
};

export function CallPanel({ call, kase, report }: { call: Call | null; kase: Case | null; report: Report | null }) {
  const session = useCallSession();
  const now = useNow(1000);

  const phone = displayPhone(call?.caller_phone ?? report?.reporter_phone, call?.caller_phone_display);
  const name = report?.reporter_name ?? call?.caller_name ?? kase?.caller_name ?? null;
  const city = call?.caller_city ?? DEFAULT_CITY;
  const lineType = call?.line_type ?? "Mobile";
  const language = call?.language ?? "English";

  const band = confidenceBand(kase?.issue_type_confidence);
  const sentiment = call?.sentiment ?? "neutral";

  const inSession = session.room !== null;
  const callLive = call !== null && call.status === "active";
  // Our own leg of the call is the honest source when there is one; with no
  // session of our own the panel reports the call it is watching.
  const status = inSession
    ? (CONNECTION_COPY[session.connection] ?? CONNECTION_COPY[ConnectionState.Disconnected])
    : callLive
      ? { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-600" }
      : call
        ? { label: "Call ended", dot: "bg-slate-400", text: "text-slate-600" }
        : { label: "No active call", dot: "bg-slate-300", text: "text-slate-500" };

  const audioLive = inSession && session.connected && session.micEnabled;
  // A finished call must stop counting, so freeze the clock at `ended_at`.
  const until = call?.ended_at ? parseServerTime(call.ended_at).getTime() : now;
  const duration = call ? formatDuration(call.started_at, until) : null;

  return (
    <ConsoleCard className="flex h-full flex-col px-5 py-[18px]">
      <CardHeading
        title="Current Call"
        action={
          // Call -> Report -> Case. Once a report exists the link carries it,
          // so a supervisor lands on this caller's own account rather than
          // having to find them among the case's reporters.
          kase ? (
            <Link
              href={report ? `/cases/${kase.id}?report=${report.id}` : `/cases/${kase.id}`}
              className="truncate text-right text-[12px] font-medium whitespace-nowrap text-blue-600 transition-colors hover:text-blue-700"
            >
              Case {kase.case_number}
            </Link>
          ) : (
            <span className="truncate text-right text-[12px] whitespace-nowrap text-slate-400">Case pending</span>
          )
        }
      />

      <div className="mt-4 flex shrink-0 flex-col items-center">
        <CallerAvatar name={name} />

        <p className="mt-3 h-7 w-full truncate text-center text-[19px] leading-7 font-semibold tracking-[-0.01em] text-slate-900">
          {name ?? <span className="text-slate-300">Caller unidentified</span>}
        </p>
        <p className="h-6 text-[16px] leading-6 font-semibold tracking-[-0.01em] text-blue-600 tabular-nums">
          {phone ?? <span className="font-normal text-slate-300">Number not captured yet</span>}
        </p>
        <p className="h-[18px] text-[12.5px] leading-[18px] text-slate-500">{city}</p>

        <div className="mt-3 flex h-[26px] items-center gap-2">
          <Chip icon={<PhoneIcon className="h-3.5 w-3.5" />}>{lineType}</Chip>
          <Chip icon={<GlobeIcon className="h-3.5 w-3.5" />}>{language}</Chip>
        </div>
      </div>

      <hr className="my-4 shrink-0 border-slate-100" />

      <div className="flex h-5 shrink-0 items-center gap-1.5">
        <SparkleIcon className="h-4 w-4 shrink-0 text-blue-600" />
        <h3 className="text-[13px] font-semibold text-slate-900">Voice Agent</h3>
      </div>
      {/* Two lines are reserved: the activity line rewrites itself as the call
          moves through its phases, and it must not push the controls down. */}
      <p className="mt-1 line-clamp-2 h-9 shrink-0 text-[12.5px] leading-[18px] text-slate-500">{activityLine(call)}</p>

      <div className="mt-2.5 grid shrink-0 grid-cols-3 gap-2">
        <Stat label="Confidence">
          {band ? (
            <Pill tone={CONFIDENCE_PILL[band]}>{CONFIDENCE_LABEL[band]}</Pill>
          ) : (
            <Pill tone="bg-slate-100 text-slate-400">Pending</Pill>
          )}
        </Stat>
        <Stat label="Sentiment">
          <Pill tone={SENTIMENT_PILL[sentiment]}>{SENTIMENT_LABEL[sentiment]}</Pill>
        </Stat>
        <Stat label="Volume">
          <VolumeMeter live={session.connected && session.micEnabled} />
        </Stat>
      </div>

      <div className="mt-4 flex h-7 shrink-0 items-center justify-between gap-3">
        <span className={`flex items-center gap-2 text-[13px] font-medium ${status.text}`}>
          <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        <span className="text-[21px] leading-7 font-semibold tracking-[-0.02em] text-slate-900 tabular-nums">
          {duration ?? "00:00"}
        </span>
      </div>

      <div className="mt-2.5 shrink-0 border-y border-slate-100 py-2.5">
        <Waveform live={audioLive} />
      </div>

      <p className="mt-2.5 flex h-4 shrink-0 items-center justify-center gap-1.5 text-[12px] text-slate-500">
        {audioLive ? <MicIcon className="h-3.5 w-3.5 shrink-0" /> : <MicOffIcon className="h-3.5 w-3.5 shrink-0" />}
        {inSession
          ? session.micEnabled
            ? "Agent voice active"
            : "Microphone muted"
          : "Start a call to speak to the agent"}
      </p>

      <div className="mt-3.5 grid shrink-0 grid-cols-4 gap-2">
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

      <div className="mt-2 grid shrink-0 grid-cols-2 gap-2">
        <button
          type="button"
          onClick={session.start}
          disabled={session.starting || inSession}
          title={inSession ? "End the current call before starting another" : undefined}
          className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-blue-600 text-[13px] font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          <PhoneIcon className="h-4 w-4" />
          {session.starting ? "Starting" : "Start new call"}
        </button>
        <button
          type="button"
          disabled
          title="Transfer is not wired up in this demo"
          className="flex h-10 cursor-not-allowed items-center justify-center gap-2 rounded-[10px] border border-slate-200 bg-white text-[13px] font-medium text-slate-600 opacity-45"
        >
          <PeopleIcon className="h-4 w-4" />
          Transfer call
        </button>
      </div>

      <p className="mt-3 flex shrink-0 items-center justify-center gap-1.5 text-center text-[12px] text-slate-400">
        <LockIcon className="h-3.5 w-3.5 shrink-0" />
        Calls are encrypted and recorded for quality and training.
      </p>
    </ConsoleCard>
  );
}

/** First letter of the first and last name, at most two. */
function monogram(name: string | null): string | null {
  if (!name) return null;
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

/**
 * The caller, as a monogram once they are named and as a silhouette until then.
 *
 * Hand-authored so the page keeps carrying no icon dependency. The glyph is
 * drawn in the circle's own coordinate space, so it is optically centred at any
 * rendered size: the silhouette group is nudged up by three units because a
 * head-and-shoulders bust reads low when it is centred geometrically.
 */
function CallerAvatar({ name }: { name: string | null }) {
  const initials = monogram(name);

  return (
    <svg
      viewBox="0 0 96 96"
      className="h-24 w-24 shrink-0"
      role="img"
      aria-label={name ? `${name}` : "Caller not yet identified"}
    >
      <circle cx="48" cy="48" r="48" fill="#eff6ff" />
      <circle cx="48" cy="48" r="47" fill="none" stroke="#dbeafe" strokeWidth="2" />
      {initials ? (
        <text
          x="48"
          y="48"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="33"
          fontWeight="600"
          letterSpacing="0.5"
          fill="#2563eb"
        >
          {initials}
        </text>
      ) : (
        <g fill="#93c5fd" transform="translate(0 -3)">
          <circle cx="48" cy="38" r="13" />
          <path d="M48 54c-11.9 0-21.5 9.6-21.5 21.5V80h43v-4.5C69.5 63.6 59.9 54 48 54Z" />
        </g>
      )}
    </svg>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-600">
      <span className="text-slate-400">{icon}</span>
      {children}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-slate-200 px-2 py-2">
      <span className="text-[11px] font-medium tracking-[0.01em] text-slate-400">{label}</span>
      <span className="flex h-[22px] items-center">{children}</span>
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
      className={`flex h-[58px] flex-col items-center justify-center gap-1.5 rounded-[10px] border text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-inherit ${tone}`}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
}
