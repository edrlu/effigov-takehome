"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhaseTrack } from "@/components/PhaseTrack";
import { EmptyState, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { callPhase, type Call, type TranscriptDelta, type Turn, type TurnRole } from "@/lib/types";
import { formatClock, formatDuration } from "@/lib/time";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

const ROLE_STYLE: Record<TurnRole, { label: string; className: string }> = {
  caller: { label: "Caller", className: "text-accent" },
  agent: { label: "Agent", className: "text-muted" },
};

/** Within this many pixels of the bottom counts as following the tail. */
const PIN_SLACK_PX = 60;

type Line =
  | { kind: "final"; turnSeq: number; role: TurnRole; text: string; at: string }
  | { kind: "interim"; turnSeq: number; role: TurnRole; text: string };

/**
 * Live transcript for one call.
 *
 * History comes from REST; after that, `transcript.turn` frames are the durable
 * record and `transcript.delta` frames are ephemeral interim speech. A delta
 * carries the full utterance so far and the `turn_seq` its final will use, so
 * the provisional line is replaced in place rather than appended to - the line
 * never duplicates when the final lands, and never concatenates.
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
  const [interim, setInterim] = useState<Map<number, TranscriptDelta>>(() => new Map());
  const [behind, setBehind] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = useNow(1000);
  const callId = call?.id ?? null;

  const load = useCallback(
    (id: number) =>
      api
        .callTurns(id)
        .then((rows) => {
          setTurns(rows);
        })
        .catch(() => {
          setTurns([]);
        }),
    [],
  );

  useEffect(() => {
    if (callId === null) {
      setTurns(null);
      setInterim(new Map());
      return;
    }
    let cancelled = false;
    setTurns(null);
    setInterim(new Map());
    pinned.current = true;
    setBehind(false);
    void api
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
        const index = rows.findIndex((row) => row.turn_seq === turn.turn_seq);
        if (index === -1) return [...rows, turn].sort((a, b) => a.turn_seq - b.turn_seq);
        // A replayed final is the same row, not a second one.
        const next = rows.slice();
        next[index] = turn;
        return next;
      });
      setInterim((previous) => {
        if (!previous.has(turn.turn_seq)) return previous;
        const next = new Map(previous);
        next.delete(turn.turn_seq);
        return next;
      });
    },
    [callId],
  );

  const applyDelta = useCallback(
    (delta: TranscriptDelta) => {
      if (delta.call_id !== callId) return;
      setInterim((previous) => {
        const next = new Map(previous);
        next.set(delta.turn_seq, delta);
        return next;
      });
    },
    [callId],
  );

  useLiveEvents(
    { "transcript.turn": appendTurn, "transcript.delta": applyDelta },
    () => {
      // Interim speech is not replayable, so drop it and rebuild from the
      // durable turns rather than leaving an orphaned provisional line.
      setInterim(new Map());
      return callId === null ? undefined : load(callId);
    },
  );

  const lines: Line[] = useMemo(() => {
    const finals = turns ?? [];
    const settled = new Set(finals.map((turn) => turn.turn_seq));
    const rows: Line[] = finals.map((turn) => ({
      kind: "final",
      turnSeq: turn.turn_seq,
      role: turn.role,
      text: turn.text,
      at: turn.created_at,
    }));
    for (const delta of interim.values()) {
      if (settled.has(delta.turn_seq)) continue;
      rows.push({ kind: "interim", turnSeq: delta.turn_seq, role: delta.role, text: delta.text });
    }
    return rows.sort((a, b) => a.turnSeq - b.turnSeq);
  }, [turns, interim]);

  const jumpToLatest = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = true;
    setBehind(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, []);

  // Follow the tail, but never yank the view away from someone reading history.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (pinned.current) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    setBehind(node.scrollHeight - node.scrollTop - node.clientHeight >= PIN_SLACK_PX);
  }, [lines]);

  const handleScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const atTail = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_SLACK_PX;
    pinned.current = atTail;
    setBehind(!atTail && lines.length > 0);
  };

  const live = call?.status === "active";
  const phase = call ? callPhase(call) : null;

  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel ${className}`}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Transcript</h2>
          {call ? <span className="truncate font-mono text-[12px] text-faint">{call.room}</span> : null}
        </div>
        {call && phase ? (
          <div className="flex shrink-0 items-center gap-3">
            <PhaseTrack phase={phase} compact />
            {/* The phase track already names the end of a call; only a live one
                needs the running clock beside it. */}
            {live ? (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-green-300">
                <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-green-400" />
                <span className="tabular-nums">{formatDuration(call.started_at, now)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* `relative` so the catch-up button floats over the tail rather than
          stealing a row of transcript height when it appears. */}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={handleScroll} className="scroll-slim h-full overflow-y-auto">
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
          ) : lines.length === 0 ? (
            <EmptyState
              title={live ? "Waiting for the first words" : "No transcript captured"}
              hint={live ? "Turns appear the moment either side speaks." : undefined}
            />
          ) : (
            <ol className="divide-y divide-line/60" aria-live="polite" aria-relevant="additions">
              {lines.map((line) => {
                const role = ROLE_STYLE[line.role] ?? ROLE_STYLE.agent;
                const interimLine = line.kind === "interim";
                return (
                  <li
                    key={line.turnSeq}
                    // Interim text changes several times a second; announcing
                    // each revision would flood a screen reader, so only the
                    // final turn is spoken.
                    aria-hidden={interimLine || undefined}
                    className={`flex gap-3 px-4 py-2.5 ${
                      interimLine ? "bg-accent/4" : "rise-in"
                    }`}
                  >
                    {/* Same width whether it holds a clock or the interim
                        marker, so the line does not shift when it settles. */}
                    <span className="w-[52px] shrink-0 pt-px font-mono text-[11px] tabular-nums text-faint">
                      {interimLine ? (
                        <span className="flex h-4 items-center gap-[3px]" title="Still being spoken">
                          <span className="interim-dot h-1 w-1 rounded-full bg-accent" />
                          <span className="interim-dot h-1 w-1 rounded-full bg-accent" />
                          <span className="interim-dot h-1 w-1 rounded-full bg-accent" />
                        </span>
                      ) : (
                        formatClock(line.at)
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className={`text-[11px] font-medium ${role.className}`}>
                        {role.label}
                        {interimLine ? <span className="ml-1.5 text-faint italic">speaking</span> : null}
                      </span>
                      <p
                        className={`mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap ${
                          interimLine ? "interim-pulse text-muted italic" : "text-ink"
                        }`}
                      >
                        {line.text}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {behind ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <button
              type="button"
              onClick={jumpToLatest}
              className="rise-in pointer-events-auto flex items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3 py-1 text-[11px] text-ink shadow-lg shadow-canvas/70 transition-colors hover:border-accent/60 hover:text-accent"
            >
              <span aria-hidden>&#8595;</span>
              Jump to latest
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
