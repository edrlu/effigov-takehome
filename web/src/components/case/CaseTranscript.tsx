"use client";

/**
 * The call transcript, light theme.
 *
 * History comes from REST; after that `transcript.turn` frames are the durable
 * record and `transcript.delta` frames are ephemeral interim speech. A delta
 * carries the whole utterance so far plus the `turn_seq` its final will use, so
 * the provisional line is replaced in place - never appended to, never
 * duplicated when the final lands.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatClock } from "@/lib/time";
import type { Call, TranscriptDelta, Turn, TurnRole } from "@/lib/types";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useTailFollow } from "@/lib/useTailFollow";
import { Card, EmptyLine, SkeletonBar } from "./ui";

const ROLE: Record<TurnRole, { label: string; className: string }> = {
  caller: { label: "Caller", className: "text-blue-600" },
  agent: { label: "Agent", className: "text-slate-500" },
};

type Line =
  | { kind: "final"; turnSeq: number; role: TurnRole; text: string; at: string }
  | { kind: "interim"; turnSeq: number; role: TurnRole; text: string };

export function CaseTranscript({ call, loading = false }: { call: Call | null; loading?: boolean }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [interim, setInterim] = useState<Map<number, TranscriptDelta>>(() => new Map());
  const callId = call?.id ?? null;

  const load = useCallback(
    (id: number) =>
      api
        .callTurns(id)
        .then(setTurns)
        .catch(() => setTurns([])),
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
      setInterim((previous) => new Map(previous).set(delta.turn_seq, delta));
    },
    [callId],
  );

  useLiveEvents({ "transcript.turn": appendTurn, "transcript.delta": applyDelta }, () => {
    // Interim speech is not replayable: drop it and rebuild from the finals.
    setInterim(new Map());
    return callId === null ? undefined : load(callId);
  });

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

  // Follow the tail without yanking the view away from someone reading back.
  const tail = useTailFollow(lines);

  return (
    <Card
      title="Transcript"
      action={call ? <span className="font-mono text-[12px] text-slate-400">{call.room}</span> : null}
      bodyClassName="px-0 pt-1 pb-0"
    >
      <div ref={tail.ref} onScroll={tail.onScroll} className="scroll-slim max-h-[620px] overflow-y-auto">
        {loading || (call && turns === null) ? (
          <div className="space-y-4 px-5 py-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <SkeletonBar className="h-3 w-12 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <SkeletonBar className="h-3 w-14" />
                  <SkeletonBar className="h-3.5 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : !call ? (
          <EmptyLine>No call is linked to this case, so there is no transcript.</EmptyLine>
        ) : lines.length === 0 ? (
          <EmptyLine>
            {call.status === "active" ? "Waiting for the first words." : "No transcript was captured on this call."}
          </EmptyLine>
        ) : (
          <ol className="divide-y divide-slate-100" aria-live="polite" aria-relevant="additions">
            {lines.map((line) => {
              const role = ROLE[line.role] ?? ROLE.agent;
              const provisional = line.kind === "interim";
              return (
                <li
                  key={line.turnSeq}
                  // Interim text revises several times a second; announcing
                  // each revision would flood a screen reader.
                  aria-hidden={provisional || undefined}
                  className={`flex gap-3 px-5 py-2.5 ${provisional ? "bg-blue-50/50" : ""}`}
                >
                  <span className="w-[52px] shrink-0 pt-px font-mono text-[11px] text-slate-400 tabular-nums">
                    {provisional ? (
                      <span className="flex h-4 items-center gap-[3px]" title="Still being spoken">
                        <span className="interim-dot h-1 w-1 rounded-full bg-blue-500" />
                        <span className="interim-dot h-1 w-1 rounded-full bg-blue-500" />
                        <span className="interim-dot h-1 w-1 rounded-full bg-blue-500" />
                      </span>
                    ) : (
                      formatClock(line.at)
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className={`text-[11px] font-semibold ${role.className}`}>{role.label}</span>
                    <p
                      className={`mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap ${
                        provisional ? "interim-pulse text-slate-500 italic" : "text-slate-800"
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
    </Card>
  );
}
