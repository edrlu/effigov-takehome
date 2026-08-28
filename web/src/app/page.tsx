"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActiveCallsBar } from "@/components/ActiveCallsBar";
import { CaseTable, CaseTableSkeleton } from "@/components/CaseTable";
import { PendingUpdates } from "@/components/PendingUpdates";
import { EmptyState, ErrorNote } from "@/components/ui";
import { api } from "@/lib/api";
import { DEPARTMENT_LABEL, ISSUE_LABEL, STATUS_LABEL } from "@/lib/labels";
import { CASE_STATUSES, caseLocation, type Case, type CaseStatus } from "@/lib/types";
import { useEngagement, useHeldOrder } from "@/lib/useHeldOrder";
import { useFlash } from "@/lib/useFlash";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useNow } from "@/lib/useNow";
import { parseServerTime } from "@/lib/time";

type Filter = CaseStatus | "all";
type SortKey = "recent" | "priority";

const FILTERS: Filter[] = ["all", ...CASE_STATUSES];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "priority", label: "Priority score" },
];

function updatedAt(item: Case): number {
  return parseServerTime(item.updated_at).getTime();
}

function comparator(sort: SortKey) {
  return (a: Case, b: Case) => {
    if (sort === "priority") {
      const delta = (b.priority_score ?? 0) - (a.priority_score ?? 0);
      if (delta !== 0) return delta;
    }
    return updatedAt(b) - updatedAt(a);
  };
}

function matches(item: Case, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    item.case_number,
    caseLocation(item),
    item.description,
    item.summary,
    item.escalation_reason,
    item.issue_type ? ISSUE_LABEL[item.issue_type] : null,
    item.department ? DEPARTMENT_LABEL[item.department] : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

const caseId = (item: Case) => item.id;

export default function CasesPage() {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  /** Field-level highlights, keyed `<case id>:<field>`. */
  const { flash: flashField, flashed: flashedFields } = useFlash<string>();
  const now = useNow(10_000);

  const load = useCallback(() => {
    setError(null);
    return api
      .listCases()
      .then((rows) => setCases(rows))
      .catch((cause: Error) => {
        setCases([]);
        setError(cause.message);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = useCallback((incoming: Case) => {
    setCases((previous) => {
      const rows = previous ?? [];
      const index = rows.findIndex((item) => item.id === incoming.id);
      if (index === -1) return [incoming, ...rows];
      const next = rows.slice();
      next[index] = incoming;
      return next;
    });
  }, []);

  const highlight = useCallback(
    (item: Case, changed: string[]) => {
      for (const field of changed) flashField(`${item.id}:${field}`);
    },
    [flashField],
  );

  useLiveEvents(
    {
      "case.created": (payload) => {
        upsert(payload);
        highlight(payload, ["created"]);
      },
      "case.updated": (payload) => {
        upsert(payload.case);
        highlight(payload.case, payload.changed);
      },
      "case.escalated": (payload) => {
        upsert(payload);
        highlight(payload, ["escalated", "priority_score"]);
      },
      "report.filed": (payload) => {
        upsert(payload.case);
        // A merged report is the interesting one: an existing incident just
        // gained corroboration, so call out the count itself.
        highlight(payload.case, payload.merged ? ["report_count", "priority_score"] : ["created"]);
      },
    },
    load,
  );

  const counts = useMemo(() => {
    const tally: Record<Filter, number> = { all: 0, new: 0, in_progress: 0, needs_info: 0, resolved: 0 };
    for (const item of cases ?? []) {
      tally.all += 1;
      tally[item.status] += 1;
    }
    return tally;
  }, [cases]);

  const desired = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (cases ?? [])
      .filter((item) => (filter === "all" || item.status === filter) && matches(item, needle))
      .sort(comparator(sort));
  }, [cases, filter, query, sort]);

  const { engaged, handlers } = useEngagement();
  const held = useHeldOrder(desired, caseId, {
    hold: engaged,
    resetKey: `${filter}|${sort}|${query.trim().toLowerCase()}`,
  });

  const fieldFlash = useCallback(
    (id: number, field: string) => flashedFields.has(`${id}:${field}`),
    [flashedFields],
  );

  const loading = cases === null;
  const filtered = query.trim().length > 0 || filter !== "all";
  const escalatedCount = (cases ?? []).filter((item) => item.escalated).length;

  // Announce arrivals without narrating every field change on every row.
  const previousTotal = useRef(0);
  const arrivals = desired.length - previousTotal.current;
  useEffect(() => {
    previousTotal.current = desired.length;
  }, [desired.length]);

  return (
    <div className="flex flex-col gap-5">
      <ActiveCallsBar />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] leading-7 font-semibold tracking-tight">Cases</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            One case per incident, however many residents call it in.
          </p>
        </div>
        <div className="flex items-center gap-3 pb-1 text-[12px] tabular-nums text-faint">
          {escalatedCount > 0 ? <span className="text-red-300">{escalatedCount} escalated</span> : null}
          <span>{loading ? "Loading" : `${held.rows.length} of ${counts.all} shown`}</span>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {loading ? "Loading cases" : arrivals > 0 ? `${arrivals} new case${arrivals === 1 ? "" : "s"}` : ""}
      </p>

      {error ? <ErrorNote message={error} onRetry={() => void load()} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <svg
            viewBox="0 0 16 16"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search case, location, issue, department"
            aria-label="Search cases"
            className="h-8 w-full rounded-md border border-line bg-panel pr-2.5 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-accent/60 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((value) => {
            const active = filter === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`h-8 rounded-md border px-2.5 text-[12px] whitespace-nowrap transition-colors ${
                  active
                    ? "border-line-strong bg-raised text-ink"
                    : "border-line text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {value === "all" ? "All" : STATUS_LABEL[value]}
                <span className="ml-1.5 tabular-nums text-faint">
                  {counts[value]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex h-8 items-center gap-0.5 rounded-md border border-line bg-panel p-0.5">
          {SORTS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setSort(option.key)}
              className={`h-7 rounded px-2 text-[12px] whitespace-nowrap transition-colors ${
                sort === option.key ? "bg-raised text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* The pill floats in the gap above the table rather than inside it, so
          surfacing a held change neither shifts the rows nor covers a column
          header. The clipping that rounds the table lives on the inner box. */}
      <div className="relative" {...handlers}>
        <PendingUpdates added={held.added} removed={held.removed} reordered={held.reordered} onApply={held.apply} />

        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {loading ? (
            <CaseTableSkeleton />
          ) : held.rows.length === 0 ? (
            <EmptyState
              title={filtered ? "No cases match these filters" : "No cases yet"}
              hint={
                filtered
                  ? "Clear the search box or pick a different status to widen the queue."
                  : "Cases appear here the moment a resident reports one. Start a call to file the first."
              }
            />
          ) : (
            <CaseTable cases={held.rows} fieldFlash={fieldFlash} now={now} />
          )}
        </div>
      </div>
    </div>
  );
}
