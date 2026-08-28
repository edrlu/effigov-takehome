"use client";

/**
 * The case's audit trail as a vertical timeline.
 *
 * REST supplies the history once; every row after that arrives as its own
 * `event.appended` frame, so the timeline grows during a live call without a
 * refetch. The compact form on the Overview tab and the full list on the
 * Activity tab are the same component with a different `limit`.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { EVENT_LABEL, actorLabel, fieldLabel, prettyValue } from "@/lib/labels";
import { formatDateTime, relativeTime } from "@/lib/time";
import type { CaseEvent, EventKind } from "@/lib/types";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";
import { Icon, type IconName } from "./icons";
import { Card, EmptyLine, SkeletonBar } from "./ui";

/** Glyph and colour per event kind, so a scan reads shape before text. */
const KIND_STYLE: Record<string, { icon: IconName; tone: string }> = {
  "case.created": { icon: "plus", tone: "border-blue-200 bg-blue-50 text-blue-600" },
  "case.updated": { icon: "pencil", tone: "border-slate-200 bg-slate-50 text-slate-500" },
  "note.added": { icon: "note", tone: "border-purple-200 bg-purple-50 text-purple-600" },
  "call.started": { icon: "phone", tone: "border-emerald-200 bg-emerald-50 text-emerald-600" },
  "call.phase": { icon: "refresh", tone: "border-emerald-200 bg-emerald-50 text-emerald-600" },
  "call.ended": { icon: "phone", tone: "border-slate-200 bg-slate-50 text-slate-500" },
  "report.filed": { icon: "user", tone: "border-blue-200 bg-blue-50 text-blue-600" },
  "report.merged": { icon: "user", tone: "border-blue-200 bg-blue-50 text-blue-600" },
  "case.escalated": { icon: "flame", tone: "border-red-200 bg-red-50 text-red-600" },
  "case.routed": { icon: "building", tone: "border-amber-200 bg-amber-50 text-amber-600" },
  "priority.changed": { icon: "flag", tone: "border-amber-200 bg-amber-50 text-amber-600" },
};

const FALLBACK_STYLE = { icon: "pencil" as IconName, tone: "border-slate-200 bg-slate-50 text-slate-500" };

function subtitle(event: CaseEvent): string {
  // An escalation's "old value" is just `False`; the reason is the whole story.
  if (event.kind === "case.escalated" && event.new_value) return event.new_value;
  if (event.field && event.old_value !== event.new_value) {
    const from = prettyValue(event.old_value);
    const to = prettyValue(event.new_value);
    return `${fieldLabel(event.field)}: ${from} to ${to}`;
  }
  if (event.new_value) return prettyValue(event.new_value);
  return actorLabel(event.actor);
}

export function ActivityTimeline({
  caseId,
  limit,
  onViewAll,
}: {
  caseId: number;
  /** Compact mode: only the newest `limit` entries, with a link to the rest. */
  limit?: number;
  onViewAll?: () => void;
}) {
  const [events, setEvents] = useState<CaseEvent[] | null>(null);
  const { flash, flashed } = useFlash<number>();
  const now = useNow(10_000);

  const load = useCallback(
    () =>
      api
        .caseEvents(caseId)
        .then(setEvents)
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

  const newestFirst = [...(events ?? [])].reverse();
  const shown = typeof limit === "number" ? newestFirst.slice(0, limit) : newestFirst;
  const hidden = newestFirst.length - shown.length;

  return (
    <Card title="Activity Timeline">
      {events === null ? (
        <div className="space-y-4 py-2">
          {Array.from({ length: limit ?? 4 }).map((_, index) => (
            <div key={index} className="flex items-start gap-3">
              <SkeletonBar className="h-7 w-7 rounded-full" />
              <div className="flex-1 space-y-1.5 pt-1">
                <SkeletonBar className="h-3 w-32" />
                <SkeletonBar className="h-3 w-44" />
              </div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyLine>Nothing has happened on this case yet.</EmptyLine>
      ) : (
        <ol>
          {shown.map((event, index) => {
            const style = KIND_STYLE[event.kind] ?? FALLBACK_STYLE;
            const last = index === shown.length - 1;
            return (
              <li key={event.id} className="relative flex gap-3.5 pb-5 last:pb-0">
                {!last ? (
                  // The dot is 28px tall and its centre sits at x=14, so the
                  // connector runs from just under one dot to just above the
                  // next on that exact centre line - no kink, no float.
                  <span aria-hidden className="absolute top-[30px] bottom-[2px] left-[13.5px] w-px bg-slate-200" />
                ) : null}
                <span
                  className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${style.tone}`}
                >
                  <Icon name={style.icon} className="h-3.5 w-3.5" />
                </span>
                <div
                  className={`-mx-1.5 flex min-w-0 flex-1 items-start justify-between gap-3 rounded-lg px-1.5 py-0.5 ${
                    flashed.has(event.id) ? "flash" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] leading-[18px] font-semibold text-slate-900">
                      {EVENT_LABEL[event.kind as EventKind] ?? event.kind}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-[18px] break-words text-slate-500">{subtitle(event)}</p>
                  </div>
                  <span
                    className="shrink-0 pt-px text-[11.5px] leading-[18px] whitespace-nowrap text-slate-400"
                    title={formatDateTime(event.created_at)}
                  >
                    {relativeTime(event.created_at, now)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {onViewAll && events !== null ? (
        // The rule sits on the wrapper, not the button: a hairline that stops
        // at the end of the label reads as a stray underline.
        <div className="mt-4 border-t border-hairline-soft pt-4">
          <button
            type="button"
            onClick={onViewAll}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700"
          >
            View all activity
            {hidden > 0 ? <span className="text-slate-400 tabular-nums">({hidden} more)</span> : null}
            <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </Card>
  );
}
