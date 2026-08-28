"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Call } from "@/lib/types";
import { formatDuration } from "@/lib/time";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

/** Strip of in-flight voice calls. Renders nothing when the queue is quiet. */
export function ActiveCallsBar() {
  const [calls, setCalls] = useState<Call[]>([]);
  const now = useNow(1000);

  useEffect(() => {
    let cancelled = false;
    api
      .activeCalls()
      .then((active) => {
        if (!cancelled) setCalls(active);
      })
      .catch(() => {
        /* the page below already surfaces API failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback((call: Call) => {
    setCalls((previous) => {
      const rest = previous.filter((item) => item.id !== call.id);
      return call.status === "active" ? [call, ...rest] : rest;
    });
  }, []);

  useLiveEvents({ "call.started": apply, "call.updated": apply });

  if (calls.length === 0) return null;

  return (
    <div className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-green-400/25 bg-green-400/6 px-4 py-3">
      <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-green-300">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-green-400" />
        {calls.length} active {calls.length === 1 ? "call" : "calls"}
      </span>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {calls.map((call) => (
          <Link
            key={call.id}
            href={`/calls/${call.id}`}
            className="group flex min-w-0 items-center gap-2 rounded-md border border-green-400/20 bg-canvas/40 px-2.5 py-1 text-[12px] transition-colors hover:border-green-400/40 hover:bg-canvas/70"
          >
            <span className="truncate font-mono text-green-200">{call.room}</span>
            <span className="shrink-0 tabular-nums text-muted">{formatDuration(call.started_at, now)}</span>
            {call.caller_phone ? (
              <span className="hidden shrink-0 text-faint sm:inline">{call.caller_phone}</span>
            ) : null}
            <span className="shrink-0 text-faint transition-colors group-hover:text-green-200" aria-hidden>
              &#8594;
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
