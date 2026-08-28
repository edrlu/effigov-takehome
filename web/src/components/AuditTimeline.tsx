"use client";

import { useCallback, useEffect, useState } from "react";
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
  "call.phase": "bg-green-400/70",
  "call.ended": "bg-line-strong",
  "case.escalated": "bg-red-400",
  "case.routed": "bg-amber-400",
  "report.filed": "bg-accent/70",
  "report.merged": "bg-accent/70",
  "priority.changed": "bg-amber-400/70",
};

/**
 * The append-only audit trail.
 *
 * REST supplies the history once; after that every row arrives as its own
 * `event.appended` frame, so the timeline streams instead of refetching the
 * whole log on every change.
 */
export function AuditTimeline({ caseId }: { caseId: number }) {
  const [events, setEvents] = useState<CaseEvent[] | null>(null);
  const { flash, flashClass } = useFlash<number>();
  const now = useNow(10_000);

  const load = useCallback(
    () =>
      api
        .caseEvents(caseId)
        .then((rows) => setEvents(rows))
        .catch(() => setEvents([])),
    [caseId],
  );

  useEffect(() => {
    setEvents(null);
    void load();
  }, [load]);

  const append = useCallback(
    (event: CaseEvent) => {
      if (event.case_id !== caseId) return;
      setEvents((previous) => {
        const rows = previous ?? [];
        // A replayed frame is the same row: match on id, never append twice.
        if (rows.some((row) => row.id === event.id)) return rows;
        return [...rows, event];
      });
      flash(event.id);
    },
    [caseId, flash],
  );

  useLiveEvents({ "event.appended": append }, load);

  return (
    <Panel title="Activity" action={<span className="text-[11px] text-faint">Newest first</span>} bodyClassName="p-0">
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
                aria-hidden
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full ${KIND_DOT[event.kind] ?? "bg-line-strong"}`}
              />

              <span className="text-[12px] font-medium text-muted">{EVENT_LABEL[event.kind] ?? event.kind}</span>

              {event.field && event.old_value !== event.new_value ? (
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
