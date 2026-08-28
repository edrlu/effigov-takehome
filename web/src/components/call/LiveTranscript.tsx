"use client";

/**
 * The call as a chat thread.
 *
 * History comes from REST once; after that `transcript.turn` frames are the
 * durable record and `transcript.delta` frames are interim speech. A delta
 * carries the full utterance so far plus the `turn_seq` its final will use, so
 * the provisional bubble resolves in place rather than duplicating or
 * concatenating when the final lands.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CardHeading, ConsoleCard } from "@/components/call/surface";
import { ChevronIcon, FilterIcon } from "@/components/call/icons";
import { api } from "@/lib/api";
import { clock12 } from "@/lib/callConsole";
import { parseServerTime } from "@/lib/time";
import type { Call, TranscriptDelta, Turn, TurnRole } from "@/lib/types";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useTailFollow } from "@/lib/useTailFollow";

const SPEAKER: Record<TurnRole, string> = { caller: "Resident", agent: "Agent" };

type Line =
  | { kind: "final"; turnSeq: number; role: TurnRole; text: string; at: string }
  | { kind: "interim"; turnSeq: number; role: TurnRole; text: string };

export function LiveTranscript({ call }: { call: Call | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [interim, setInterim] = useState<Map<number, TranscriptDelta>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const callId = call?.id ?? null;
  const callIdRef = useRef<number | null>(null);
  callIdRef.current = callId;

  const load = useCallback(async (id: number) => {
    try {
      const rows = await api.callTurns(id);
      if (callIdRef.current === id) setTurns(rows);
    } catch {
      if (callIdRef.current === id) setTurns([]);
    }
  }, []);

  useEffect(() => {
    setTurns([]);
    setInterim(new Map());
    if (callId === null) return;
    setLoading(true);
    void load(callId).finally(() => setLoading(false));
  }, [callId, load]);

  const appendTurn = useCallback((turn: Turn) => {
    if (turn.call_id !== callIdRef.current) return;
    setTurns((previous) => {
      const index = previous.findIndex((row) => row.turn_seq === turn.turn_seq);
      if (index === -1) return [...previous, turn].sort((a, b) => a.turn_seq - b.turn_seq);
      // A replayed final is the same row, not a second one.
      const next = previous.slice();
      next[index] = turn;
      return next;
    });
    setInterim((previous) => {
      if (!previous.has(turn.turn_seq)) return previous;
      const next = new Map(previous);
      next.delete(turn.turn_seq);
      return next;
    });
  }, []);

  const applyDelta = useCallback((delta: TranscriptDelta) => {
    if (delta.call_id !== callIdRef.current) return;
    setInterim((previous) => new Map(previous).set(delta.turn_seq, delta));
  }, []);

  useLiveEvents({ "transcript.turn": appendTurn, "transcript.delta": applyDelta }, () => {
    // Interim speech is not replayable: drop it and rebuild from the durable
    // turns rather than leaving an orphaned provisional bubble on screen.
    setInterim(new Map());
    const id = callIdRef.current;
    return id === null ? undefined : load(id);
  });

  const lines: Line[] = useMemo(() => {
    const settled = new Set(turns.map((turn) => turn.turn_seq));
    const rows: Line[] = turns.map((turn) => ({
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

  const agentSpeaking = lines.some((line) => line.kind === "interim" && line.role === "agent");

  // Interim text grows the last bubble without adding a line, so the signal has
  // to move on revisions too, not only on new turns.
  const tail = useTailFollow(`${lines.length}:${lines.at(-1)?.text.length ?? 0}:${agentSpeaking}`);

  return (
    // A fixed rectangle, empty or full. The tail-follow behaviour is unchanged:
    // it pins to the newest line unless the reader has scrolled up.
    <ConsoleCard className="flex h-[420px] min-h-0 flex-col px-5 py-[18px] xl:h-auto xl:flex-1">
      <CardHeading
        title="Live Transcript"
        action={
          <>
            <FilterIcon className="h-4 w-4 text-slate-400" />
            <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600">
              AI summary
              <ChevronIcon className="h-3.5 w-3.5 text-slate-400" />
            </span>
          </>
        }
      />

      <div
        ref={tail.ref}
        onScroll={tail.onScroll}
        className="scroll-slim mt-3.5 -mr-2 min-h-0 flex-1 overflow-y-auto pr-2"
      >
        {lines.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-[13px] text-slate-400">
            {loading
              ? "Loading the transcript"
              : call
                ? "Waiting for the first words of the call."
                : "Start a call and the conversation streams here."}
          </p>
        ) : (
          <ol className="space-y-2.5" aria-live="polite" aria-relevant="additions">
            {lines.map((line) => (
              <Bubble key={line.turnSeq} line={line} />
            ))}
          </ol>
        )}

        {agentSpeaking ? (
          <div className="mt-2.5 flex justify-end">
            <span className="flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2 text-[12px] text-slate-500">
              <span aria-hidden className="flex items-center gap-[3px]">
                <span className="interim-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                <span className="interim-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
                <span className="interim-dot h-1.5 w-1.5 rounded-full bg-slate-400" />
              </span>
              Agent is typing...
            </span>
          </div>
        ) : null}
      </div>
    </ConsoleCard>
  );
}

function Bubble({ line }: { line: Line }) {
  const resident = line.role === "caller";
  const interim = line.kind === "interim";

  return (
    <li
      // Interim text is revised several times a second; announcing each
      // revision would flood a screen reader, so only finals are spoken.
      aria-hidden={interim || undefined}
      className={`flex ${resident ? "justify-start" : "justify-end"}`}
    >
      <div
        className={`rise-in max-w-[80%] rounded-2xl px-3.5 py-2.5 ${
          resident ? "bg-blue-50/90" : "bg-slate-100"
        } ${interim ? "opacity-80" : ""}`}
      >
        <p className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-slate-900">{SPEAKER[line.role]}</span>
          <span className="text-[11px] text-slate-400">
            {line.kind === "final" ? clock12(parseServerTime(line.at)) : "now"}
          </span>
        </p>
        <p className={`mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-slate-700 ${interim ? "interim-pulse" : ""}`}>
          {line.text}
        </p>
      </div>
    </li>
  );
}
