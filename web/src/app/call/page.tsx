"use client";

/**
 * The live call console.
 *
 * One page, three columns, one websocket. The resident places a real call from
 * here (LiveKit, exactly as before), while the same panels a supervisor would
 * watch fill in from the contract-v1 stream: what the agent extracted, what the
 * case recorded, and what was said. Nothing on this page polls or waits for a
 * refresh.
 *
 * It is also the only light-themed page in the app. The palette is declared
 * locally, on this page and its own components, so the dark dashboard is
 * untouched.
 */

import "@livekit/components-styles";
import Link from "next/link";
import { CallControls } from "@/components/call/CallControls";
import { CaseActivity } from "@/components/call/CaseActivity";
import { CurrentCall } from "@/components/call/CurrentCall";
import { ExtractedInfo } from "@/components/call/ExtractedInfo";
import { LiveTranscript } from "@/components/call/LiveTranscript";
import { CallSessionProvider, useCallSession } from "@/components/call/session";
import { useCallConsole } from "@/lib/useCallConsole";

export default function ResidentCallPage() {
  return (
    <CallSessionProvider>
      <CallConsole />
    </CallSessionProvider>
  );
}

function CallConsole() {
  const session = useCallSession();
  const { call, kase, report, events, flashed } = useCallConsole(session.room);

  return (
    // Full-bleed: the console owns the whole viewport width under the nav, so
    // the light surface does not sit in a dark frame on a wide screen.
    <div className="cc-light -mt-6 -mb-6 ml-[calc(50%-50vw)] min-h-[calc(100vh-3.5rem)] w-[100vw] bg-[#f5f6f8] px-4 py-6 text-slate-900 sm:px-6">
      <div className="mx-auto w-full max-w-[1400px]">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[19px] leading-6 font-semibold tracking-[-0.015em] text-slate-900">
              Live call console
            </h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Talk to the city intake agent. Everything it hears is filed against a case while you speak.
            </p>
          </div>
          <Link
            href="/"
            className="text-[13px] text-slate-500 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-800"
          >
            Staff case queue
          </Link>
        </div>

        {session.error ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[13px] border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] text-red-700">{session.error}</p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={session.start}
                className="rounded-md border border-red-300 px-2.5 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={session.dismissError}
                className="rounded-md px-2.5 py-1 text-[12px] text-red-600 transition-colors hover:bg-red-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-5">
            <CallControls call={call} />
            <ExtractedInfo call={call} kase={kase} report={report} flashed={flashed} />
          </div>

          <CurrentCall call={call} kase={kase} report={report} />

          <div className="flex flex-col gap-5">
            <LiveTranscript call={call} />
            <CaseActivity events={events} kase={kase} />
          </div>
        </div>
      </div>
    </div>
  );
}
