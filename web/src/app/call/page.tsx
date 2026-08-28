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
 * The three columns are one fixed-height row (`CONSOLE_H`), sized to the merged
 * call panel when it is full. Every panel holds that rectangle whether it is empty
 * or mid-call and scrolls internally instead of growing, so no row on the page
 * moves when a transcript line, an activity entry, or an extracted field lands.
 *
 * The page carries no header row: its title and its one action are pushed into
 * the single top bar with `<PageBar />`.
 *
 * The palette is declared locally, on this page and its own components, so the
 * `@theme` tokens - which are the dark palette - are not pulled in by accident.
 */

import "@livekit/components-styles";
import { CallPanel } from "@/components/call/CallPanel";
import { CaseActivity } from "@/components/call/CaseActivity";
import { ExtractedInfo } from "@/components/call/ExtractedInfo";
import { LiveTranscript } from "@/components/call/LiveTranscript";
import { CallSessionProvider, useCallSession } from "@/components/call/session";
import { PageBar } from "@/components/PageBar";
import { useCallConsole } from "@/lib/useCallConsole";

/**
 * The height of the console row on a wide screen. It is the natural height of
 * the merged call panel, which is the tallest fixed-content column; the other
 * two stretch to meet it so the page has one clean bottom edge.
 */
const CONSOLE_H = "xl:h-[760px]";

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
    <div className="cc-light -mt-6 -mb-6 ml-[calc(50%-50vw)] min-h-[calc(100vh-3.5rem)] w-[100vw] bg-white px-4 py-5 text-slate-900 sm:px-6">
      {/* The page has no header row of its own: its title and its one action
          live in the single top bar. */}
      <PageBar title="Live call" action={{ href: "/", label: "Staff case queue" }} />

      <div className="mx-auto w-full max-w-[1400px]">
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

        {/* DOM order is the stacked order on a narrow screen - the call you are
            on, then what was said, then the audit trail. `lg:order-*` puts the
            timeline back on the left once there are three columns. */}
        <div className={`grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[1.3fr_1fr_1.15fr] ${CONSOLE_H}`}>
          <div className="min-w-0 xl:order-2 xl:min-h-0">
            <CallPanel call={call} kase={kase} report={report} />
          </div>

          <div className="flex min-w-0 flex-col gap-5 xl:order-3 xl:min-h-0">
            <LiveTranscript call={call} />
            <ExtractedInfo call={call} kase={kase} report={report} flashed={flashed} />
          </div>

          <div className="min-w-0 xl:order-1 xl:min-h-0">
            <CaseActivity events={events} kase={kase} />
          </div>
        </div>
      </div>
    </div>
  );
}
