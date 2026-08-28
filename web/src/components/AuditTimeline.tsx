"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Panel, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { EVENT_LABEL, actorLabel, fieldLabel, prettyValue } from "@/lib/labels";
import type { CaseEvent } from "@/lib/types";
import { formatDateTime, relativeTime } from "@/lib/time";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

const KIND_DOT: Record<string, string> = {
  "case.created": "bg-blue-400",
  "case.updated": "bg-accent",
  "note.added": "bg-purple-400",
  "call.started": "bg-green-400",
  "call.ended": "bg-line-strong",
};

/**
 * The append-only audit trail. Websocket payloads carry the case, not the
 * event row, so a change simply triggers a refetch of the log.
 */
export function AuditTimeline({ caseId }: { caseId: number }) {
  const [events, setEvents] = useState<CaseEvent[] | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { flash, flashClass } = useFlash<number>();
  const now = useNow(10_000);

  const load = useCallback(
    (highlight: boolean) => {
      api
        .caseEvents(caseId)
        .then((rows) => {
          if (highlight) {
            for (const row of rows) {
              if (!seen.current.has(row.id)) flash(row.id);
            }
          }
          seen.current = new Set(rows.map((row) => row.id));
          setEvents(rows);
        })
        .catch(() => setEvents([]));
    },
    [caseId, flash],
  );

  useEffect(() => {
    setEvents(null);
    seen.current = new Set();
    load(false);
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => load(true), 120);
  }, [load]);

  useLiveEvents({
    "case.updated": (payload) => {
      if (payload.case.id === caseId) refresh();
    },
    "case.created": (payload) => {
      if (payload.id === caseId) refresh();
    },
    "call.started": (payload) => {
      if (payload.case_id === caseId) refresh();
    },
    "call.updated": (payload) => {
      if (payload.case_id === caseId) refresh();
    },
  });

  return (
    <Panel
      title="Activity"
      action={<span className="text-[11px] text-faint">Newest first</span>}
      bodyClassName={events && events.length > 0 ? "p-0" : "p-0"}
    >
      {events === null ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="h-1.5 w-1.5 rounded-full" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState title="No activity yet" hint="Every field change and note lands here with an actor and a time." />
      ) : (
        <ol className="divide-y divide-line/60">
          {[...events].reverse().map((event) => (
            <li
              key={event.id}
              className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 ${flashClass(event.id)}`}
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full ${KIND_DOT[event.kind] ?? "bg-line-strong"}`}
              />

              <span className="text-[12px] font-medium text-muted">
                {EVENT_LABEL[event.kind] ?? event.kind}
              </span>

              {event.kind === "case.updated" && event.field ? (
                <span className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-[13px]">
                  <span className="text-faint">{fieldLabel(event.field)}:</span>
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[12px] text-muted line-through decoration-faint/70">
                    {prettyValue(event.old_value)}
                  </span>
                  <span className="text-faint" aria-hidden>
                    &#8594;
                  </span>
                  <span className="rounded bg-accent/12 px-1.5 py-0.5 text-[12px] text-ink">
                    {prettyValue(event.new_value)}
                  </span>
                </span>
              ) : event.new_value ? (
                <span className="min-w-0 max-w-full truncate text-[13px] text-ink">{prettyValue(event.new_value)}</span>
              ) : null}

              <span className="ml-auto shrink-0 text-[12px] whitespace-nowrap text-faint">
                {actorLabel(event.actor)} &middot;{" "}
                <span title={formatDateTime(event.created_at)}>{relativeTime(event.created_at, now)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
