"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Panel, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import type { Case, Report } from "@/lib/types";
import { formatDateTime, parseServerTime, relativeTime } from "@/lib/time";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";

function newestFirst(a: Report, b: Report): number {
  return parseServerTime(b.created_at).getTime() - parseServerTime(a.created_at).getTime();
}

/**
 * Every resident who called about this incident. Deduplication happens in the
 * backend; this only renders what it decided.
 */
export function ReportsPanel({ caseItem }: { caseItem: Case }) {
  const caseId = caseItem.id;
  const [reports, setReports] = useState<Report[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { flash, flashed } = useFlash<number>();
  const now = useNow(10_000);

  useEffect(() => {
    let cancelled = false;
    setReports(null);
    api
      .caseReports(caseId)
      .then((rows) => {
        if (cancelled) return;
        if (rows === null) {
          setUnavailable(true);
          setReports([]);
          return;
        }
        setReports(rows.slice().sort(newestFirst));
      })
      .catch(() => {
        if (!cancelled) setReports([]);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const onReport = useCallback(
    (payload: { report: Report; case: Case }) => {
      if (payload.report.case_id !== caseId) return;
      setReports((previous) => {
        const rest = (previous ?? []).filter((row) => row.id !== payload.report.id);
        return [payload.report, ...rest].sort(newestFirst);
      });
      flash(payload.report.id);
    },
    [caseId, flash],
  );

  useLiveEvents({ "report.filed": onReport });

  const count = reports?.length ?? caseItem.report_count ?? 0;

  return (
    <Panel
      title="Reports"
      action={
        <span className="text-[11px] text-faint">
          {reports === null ? "Loading" : `${count} ${count === 1 ? "resident" : "residents"}`}
        </span>
      }
      bodyClassName="p-0"
    >
      {reports === null ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="space-y-2 rounded-md border border-line p-3">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3.5 w-full" />
            </div>
          ))}
        </div>
      ) : reports.length === 0 ? (
        <EmptyState
          title={unavailable ? "Reports are not available yet" : "No reports on file"}
          hint={
            unavailable
              ? "This case API build predates the reports endpoint."
              : "Each resident who calls about this incident is listed here."
          }
        />
      ) : (
        <ul className="space-y-2 p-3">
          {reports.map((report) => (
            <li
              key={report.id}
              className={`rounded-md border border-line bg-raised/40 p-3 ${flashed.has(report.id) ? "flash" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-[13px] font-medium text-ink">
                  {report.reporter_name || "Anonymous resident"}
                </p>
                <span
                  className="shrink-0 text-[12px] whitespace-nowrap text-faint"
                  title={formatDateTime(report.created_at)}
                >
                  {relativeTime(report.created_at, now)}
                </span>
              </div>

              {report.reporter_phone ? (
                <a
                  href={`tel:${report.reporter_phone}`}
                  className="mt-0.5 inline-block font-mono text-[12px] text-muted hover:text-accent"
                >
                  {report.reporter_phone}
                </a>
              ) : (
                <p className="mt-0.5 font-mono text-[12px] text-faint">No callback number</p>
              )}

              {report.description ? (
                <p className="mt-2 text-[13px] leading-5 break-words text-muted">{report.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
