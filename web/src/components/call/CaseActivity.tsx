"use client";

/**
 * The case audit trail as a timeline.
 *
 * The rows are the real append-only audit events, not a hand-written narrative;
 * `activityEntry` is the only place that decides how each kind reads.
 */

import { useMemo } from "react";
import { CardHeading, ConsoleCard } from "@/components/call/surface";
import { ACTIVITY_BADGE, activityEntry, clock12, type ActivityTone } from "@/lib/callConsole";
import { parseServerTime } from "@/lib/time";
import { useTailFollow } from "@/lib/useTailFollow";
import type { Case, CaseEvent } from "@/lib/types";

const BADGE_GLYPH: Record<ActivityTone, string> = {
  blue: "M5 12.5 9.5 17 19 7.5",
  purple: "M4 12h16M14 6l6 6-6 6",
  amber: "M12 4.5v9M12 18.2v.3",
  green: "M5 12.5 9.5 17 19 7.5",
  red: "M12 4.5v9M12 18.2v.3",
  slate: "M12 7v5l3.5 2",
};

export function CaseActivity({ events, kase }: { events: CaseEvent[]; kase: Case | null }) {
  const entries = useMemo(
    () => events.map((event) => activityEntry(event, kase?.case_number ?? null)),
    [events, kase?.case_number],
  );

  const tail = useTailFollow(entries.length);

  return (
    <ConsoleCard className="flex min-h-0 flex-col px-5 py-[18px]">
      <CardHeading title="Case Activity" />

      <div
        ref={tail.ref}
        onScroll={tail.onScroll}
        className="scroll-slim mt-4 -mr-2 max-h-[300px] flex-1 overflow-y-auto pr-2"
      >
        {entries.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-slate-400">
            Every routing decision and field change lands here as it happens.
          </p>
        ) : (
          <ol>
            {entries.map((entry, index) => (
              <li key={entry.id} className="rise-in relative flex gap-3 pb-4 last:pb-0">
                {index < entries.length - 1 ? (
                  <span aria-hidden className="absolute top-[30px] bottom-0 left-[86px] w-px bg-slate-200" />
                ) : null}

                <time
                  dateTime={entry.at}
                  className="w-[62px] shrink-0 pt-1 text-right text-[11px] whitespace-nowrap text-slate-400 tabular-nums"
                >
                  {clock12(parseServerTime(entry.at))}
                </time>

                <span
                  className={`relative z-10 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full ${ACTIVITY_BADGE[entry.tone]}`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden
                    className="h-[13px] w-[13px]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={BADGE_GLYPH[entry.tone]} />
                  </svg>
                </span>

                <div className="min-w-0 flex-1 pt-[3px]">
                  <p className="text-[13px] leading-4 font-semibold text-slate-900">{entry.title}</p>
                  {entry.subtitle ? (
                    <p className="mt-1 text-[12px] leading-4 text-slate-500">{entry.subtitle}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </ConsoleCard>
  );
}
