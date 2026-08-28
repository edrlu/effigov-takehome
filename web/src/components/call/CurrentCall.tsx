"use client";

/**
 * Who is on the line, and what the agent is doing about it.
 */

import type { ReactNode } from "react";
import { CardHeading, ConsoleCard, Pill } from "@/components/call/surface";
import {
  GlobeIcon,
  LockIcon,
  PeopleIcon,
  PhoneIcon,
  PhoneSolidIcon,
  SparkleIcon,
} from "@/components/call/icons";
import { useCallSession } from "@/components/call/session";
import { VolumeMeter } from "@/components/call/Waveform";
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_PILL,
  SENTIMENT_LABEL,
  SENTIMENT_PILL,
  activityLine,
  confidenceBand,
  displayPhone,
} from "@/lib/callConsole";
import type { Call, Case, Report } from "@/lib/types";

const DEFAULT_CITY = "Berkeley, CA";

export function CurrentCall({ call, kase, report }: { call: Call | null; kase: Case | null; report: Report | null }) {
  const session = useCallSession();

  const phone = displayPhone(call?.caller_phone ?? report?.reporter_phone, call?.caller_phone_display);
  const name = report?.reporter_name ?? call?.caller_name ?? kase?.caller_name ?? null;
  const city = call?.caller_city ?? DEFAULT_CITY;
  const lineType = call?.line_type ?? "Mobile";
  const language = call?.language ?? "English";

  const band = confidenceBand(kase?.issue_type_confidence);
  const sentiment = call?.sentiment ?? "neutral";
  const inSession = session.room !== null;

  return (
    <ConsoleCard className="flex flex-col px-5 py-[18px]">
      <CardHeading
        title="Current Call"
        action={
          <span className="text-right text-[12px] text-slate-400">
            {kase ? `Case ${kase.case_number}` : "Case will be created upon completion"}
          </span>
        }
      />

      <p className="mt-1.5 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-blue-600">
        {phone ?? <span className="text-slate-300">Number not captured yet</span>}
      </p>

      <div className="mt-6 flex flex-col items-center">
        <span className="flex h-[170px] w-[170px] items-center justify-center rounded-full bg-blue-50">
          <PhoneSolidIcon className="h-[68px] w-[68px] text-blue-600" />
        </span>

        <p className="mt-5 text-[20px] leading-7 font-semibold tracking-[-0.01em] text-slate-900">
          {name ?? <span className="text-slate-300">Caller unidentified</span>}
        </p>
        <p className="mt-0.5 text-[13px] text-slate-500">{city}</p>

        <div className="mt-3.5 flex items-center gap-2">
          <Chip icon={<PhoneIcon className="h-3.5 w-3.5" />}>{lineType}</Chip>
          <Chip icon={<GlobeIcon className="h-3.5 w-3.5" />}>{language}</Chip>
        </div>
      </div>

      <hr className="my-5 border-slate-100" />

      <div className="flex items-center gap-1.5">
        <SparkleIcon className="h-4 w-4 text-blue-600" />
        <h3 className="text-[13px] font-semibold text-slate-900">Voice Agent</h3>
      </div>
      <p className="mt-1.5 text-[13px] leading-5 text-slate-500">{activityLine(call)}</p>

      <div className="mt-4 grid grid-cols-3 gap-2">
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

      <div className="mt-4 grid grid-cols-2 gap-2.5">
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

      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[12px] text-slate-400">
        <LockIcon className="h-3.5 w-3.5 shrink-0" />
        Calls are encrypted and recorded for quality and training.
      </p>
    </ConsoleCard>
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
    <div className="flex flex-col items-center gap-2 rounded-[10px] border border-slate-200 px-2 py-2.5">
      <span className="text-[11px] font-medium tracking-[0.01em] text-slate-400">{label}</span>
      <span className="flex h-[22px] items-center">{children}</span>
    </div>
  );
}
