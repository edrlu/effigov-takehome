"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PhaseTrack } from "@/components/PhaseTrack";
import { Transcript } from "@/components/Transcript";
import { ErrorNote, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { callPhase, type Call, type Case } from "@/lib/types";
import { formatDateTime, formatDuration, relativeTime } from "@/lib/time";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

/** A single voice session: live transcript plus the case it produced. */
export function CallDetail({ callId }: { callId: number }) {
  const [call, setCall] = useState<Call | null>(null);
  const [linkedCase, setLinkedCase] = useState<Case | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  const load = useCallback(() => {
    setError(null);
    return api
      .getCall(callId)
      .then((next) => setCall(next))
      .catch((cause: Error) => setError(cause.message));
  }, [callId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkedId = call?.case_id ?? null;

  useEffect(() => {
    if (linkedId === null) {
      setLinkedCase(null);
      return;
    }
    let cancelled = false;
    api
      .getCase(linkedId)
      .then((found) => {
        if (!cancelled) setLinkedCase(found);
      })
      .catch(() => {
        if (!cancelled) setLinkedCase(null);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedId]);

  useLiveEvents(
    {
      "call.updated": (payload) => {
        if (payload.call.id === callId) setCall(payload.call);
      },
      "report.filed": (payload) => {
        if (payload.report.call_id === callId) setLinkedCase(payload.case);
      },
      "case.updated": (payload) => {
        setLinkedCase((previous) => (previous && previous.id === payload.case.id ? payload.case : previous));
      },
    },
    () =>
      Promise.all([
        load(),
        linkedId === null
          ? Promise.resolve()
          : api
              .getCase(linkedId)
              .then((found) => setLinkedCase(found))
              .catch(() => undefined),
      ]),
  );

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorNote message={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!call) {
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  const live = call.status === "active";
  // The backend formats the number when it can. The raw digits are storage,
  // not something to read back to a person.
  const phone = call.caller_phone_display ?? call.caller_phone;

  return (
    <div className="flex flex-col gap-5">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate font-mono text-[20px] leading-7 font-semibold tracking-tight">{call.room}</h1>
            {live ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-green-400/25 bg-green-400/10 px-2 py-0.5 text-[11px] font-medium text-green-300">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-green-400" />
                Live {formatDuration(call.started_at, now)}
              </span>
            ) : (
              <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] text-muted">
                Ended
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Started <span title={formatDateTime(call.started_at)}>{relativeTime(call.started_at, now)}</span>
            {call.caller_name ? <span className="text-ink"> &middot; {call.caller_name}</span> : null}
            {phone ? <span className="font-mono text-faint"> &middot; {phone}</span> : null}
          </p>
          <PhaseTrack phase={callPhase(call)} className="mt-2.5" />
        </div>

        {linkedCase ? (
          <Link
            href={`/cases/${linkedCase.id}`}
            className="flex h-8 items-center gap-2 rounded-md border border-line bg-panel px-3 text-[12px] text-ink transition-colors hover:border-line-strong"
          >
            <span className="font-mono">{linkedCase.case_number}</span>
            <span className="text-faint" aria-hidden>
              &#8594;
            </span>
          </Link>
        ) : (
          <span className="flex h-8 items-center rounded-md border border-line px-3 text-[12px] text-faint">
            No case linked yet
          </span>
        )}
      </div>

      {call.summary ? (
        <p className="rounded-lg border border-line bg-panel px-4 py-3 text-[13px] leading-5 text-muted">
          {call.summary}
        </p>
      ) : null}

      <Transcript call={call} className="h-[min(70vh,640px)]" />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
    >
      <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9.5 4 5.5 8l4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Cases
    </Link>
  );
}
