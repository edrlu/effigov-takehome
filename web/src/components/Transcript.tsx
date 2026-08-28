"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import type { Call, Turn } from "@/lib/types";
import { formatClock, formatDuration } from "@/lib/time";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

const ROLE_STYLE: Record<Turn["role"], { label: string; className: string }> = {
  caller: { label: "Caller", className: "text-accent" },
  agent: { label: "Agent", className: "text-muted" },
};

/**
 * Live transcript for one call: history from the API, then every
 * `transcript.turn` that belongs to this call as it arrives.
 */
export function Transcript({
  call,
  loading = false,
  className = "",
}: {
  call: Call | null;
  loading?: boolean;
  className?: string;
}) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = useNow(1000);
  const callId = call?.id ?? null;

  useEffect(() => {
    if (callId === null) {
      setTurns(null);
      return;
    }
    let cancelled = false;
    setTurns(null);
    pinned.current = true;
    api
      .callTurns(callId)
      .then((rows) => {
        if (!cancelled) setTurns(rows);
      })
      .catch(() => {
        if (!cancelled) setTurns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const appendTurn = useCallback(
    (turn: Turn) => {
      if (turn.call_id !== callId) return;
      setTurns((previous) => {
        const rows = previous ?? [];
        if (rows.some((row) => row.id === turn.id)) return rows;
        return [...rows, turn];
      });
    },
    [callId],
  );

  useLiveEvents({ "transcript.turn": appendTurn });

  // Follow the tail unless the reader has scrolled up to read history.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [turns]);

  const handleScroll = () => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  };

  const live = call?.status === "active";

  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel ${className}`}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Transcript</h2>
          {call ? <span className="truncate font-mono text-[12px] text-faint">{call.room}</span> : null}
        </div>
        {call ? (
          live ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-green-300">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-green-400" />
              Live {formatDuration(call.started_at, now)}
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-faint">Ended</span>
          )
        ) : null}
      </header>

      <div ref={scroller} onScroll={handleScroll} className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {loading || (call && turns === null) ? (
          <div className="space-y-4 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <Skeleton className="h-3 w-12 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3.5 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : !call ? (
          <EmptyState
            title="No call linked yet"
            hint="When the voice agent attaches a call to this case, the transcript streams here."
          />
        ) : turns && turns.length === 0 ? (
          <EmptyState
            title={live ? "Waiting for the first words" : "No transcript captured"}
            hint={live ? "Turns appear the moment either side speaks." : undefined}
          />
        ) : (
          <ol className="divide-y divide-line/60">
            {(turns ?? []).map((turn) => {
              const role = ROLE_STYLE[turn.role] ?? ROLE_STYLE.agent;
              return (
                <li key={turn.id} className="rise-in flex gap-3 px-4 py-2.5">
                  <span className="w-[52px] shrink-0 pt-px font-mono text-[11px] tabular-nums text-faint">
                    {formatClock(turn.created_at)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className={`text-[11px] font-medium ${role.className}`}>{role.label}</span>
                    <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-ink">
                      {turn.text}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
