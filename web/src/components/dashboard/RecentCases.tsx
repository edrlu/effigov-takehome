"use client";

/**
 * Row two: the full-width case table.
 *
 * Everything here comes from `GET /api/cases` alone. The queue is a list of
 * *incidents*, so the corroboration column says how many separate residents
 * reported each one rather than naming the first of them - a single name would
 * read as the case belonging to one caller, and it cost a per-row fetch of
 * that case's reports to show. The filter tabs are built from the four
 * statuses this system actually has.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardHeader, PanelEmpty, RevealFooter, Shimmer } from "./ui";
import { DocumentIcon } from "./icons";
import { departmentLabel, issueLabel, PRIORITY_LABEL, reportersCount, STATUS_LABEL } from "@/lib/labels";
import { CASE_STATUSES, reporterCount, type Case, type CaseStatus, type Priority } from "@/lib/types";
import { parseServerTime, relativeTime } from "@/lib/time";

type Filter = CaseStatus | "all";

const FILTERS: Filter[] = ["all", ...CASE_STATUSES];

/** How many rows "recent" means before the footer link opens the rest. */
const RECENT_ROWS = 8;

const PRIORITY_PILL: Record<Priority, string> = {
  high: "bg-[#fdeaea] text-[#c0342c]",
  normal: "bg-[#fdf2dd] text-[#a76a08]",
  low: "bg-[#e6f6ec] text-[#15803d]",
};

const HEAD = "px-5 py-2.5 text-[11px] font-medium tracking-wide text-slate-400 uppercase";
const CELL = "px-5 py-3 align-middle transition-colors";

function updatedAt(item: Case): number {
  return parseServerTime(item.updated_at).getTime();
}

export function RecentCases({
  cases,
  loading,
  error,
  fieldFlash,
  now,
}: {
  cases: Case[];
  loading: boolean;
  error: string | null;
  fieldFlash: (id: number, field: string) => boolean;
  now: number;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);

  const counts = useMemo(() => {
    const tally: Record<Filter, number> = { all: 0, new: 0, in_progress: 0, needs_info: 0, resolved: 0 };
    for (const item of cases) {
      tally.all += 1;
      tally[item.status] += 1;
    }
    return tally;
  }, [cases]);

  const matching = useMemo(
    () => cases.filter((item) => filter === "all" || item.status === filter).sort((a, b) => updatedAt(b) - updatedAt(a)),
    [cases, filter],
  );

  const rows = expanded ? matching : matching.slice(0, RECENT_ROWS);

  return (
    <Card>
      <CardHeader
        title="Recent Cases"
        action={
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            disabled={!expanded && matching.length <= RECENT_ROWS}
            className="rounded-lg border border-hairline bg-sheet px-3 py-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:bg-inset disabled:cursor-default disabled:text-slate-300 disabled:hover:bg-sheet"
          >
            {expanded ? "Show recent" : "View all cases"}
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-4">
        {FILTERS.map((value) => {
          const active = filter === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${
                active ? "bg-[#eef4ff] text-[#2563eb]" : "text-slate-500 hover:bg-inset hover:text-slate-700"
              }`}
            >
              {value === "all" ? "All" : STATUS_LABEL[value]}
              <span
                className={`rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${
                  active ? "bg-[#dbe6fe] text-[#1d4ed8]" : "bg-inset text-slate-500"
                }`}
              >
                {counts[value]}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="space-y-3 px-5 pb-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Shimmer key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : error ? (
        <PanelEmpty title="Cases could not be loaded" hint={error} />
      ) : rows.length === 0 ? (
        <PanelEmpty
          title={filter === "all" ? "No cases yet" : `No ${STATUS_LABEL[filter].toLowerCase()} cases`}
          hint="Cases appear the moment a resident reports one."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-y border-hairline-soft bg-inset">
                <th className={`${HEAD} w-[15%]`}>Case ID</th>
                <th className={`${HEAD} w-[16%]`}>Reporters</th>
                <th className={`${HEAD} w-[16%]`}>Issue Type</th>
                <th className={`${HEAD} w-[16%]`}>Department</th>
                <th className={`${HEAD} w-[11%]`}>Priority</th>
                <th className={`${HEAD} w-[13%]`}>Status</th>
                <th className={`${HEAD} w-[13%]`}>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const lit = (field: string) => (fieldFlash(item.id, field) ? "flash" : "");
                const reporters = reporterCount(item);
                return (
                  <tr
                    key={item.id}
                    onClick={() => router.push(`/cases/${item.id}`)}
                    className={`cursor-pointer border-b border-hairline-soft transition-colors hover:bg-inset ${
                      fieldFlash(item.id, "created") ? "flash" : ""
                    }`}
                  >
                    <td className={CELL}>
                      <Link
                        href={`/cases/${item.id}`}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex items-center gap-2 text-[13px] font-medium text-slate-900 hover:text-[#2563eb]"
                      >
                        <DocumentIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate">{item.case_number}</span>
                      </Link>
                    </td>

                    {/* People, not calls: the backend keys one report per
                        phone number, so this cannot be inflated by re-dials. */}
                    <td className={`${CELL} text-[13px] text-slate-700 ${lit("report_count")}`}>
                      {reporters > 0 ? (
                        <span className="truncate">{reportersCount(reporters)}</span>
                      ) : (
                        <span className="text-slate-300" title="No resident report on file yet">
                          None yet
                        </span>
                      )}
                    </td>

                    <td className={`${CELL} text-[13px] text-slate-700 ${lit("issue_type")}`}>
                      {issueLabel(item.issue_type)}
                    </td>

                    <td className={`${CELL} text-[13px] text-slate-700 ${lit("department")}`}>
                      {departmentLabel(item.department)}
                    </td>

                    <td className={`${CELL} ${lit("priority")}`}>
                      <span
                        className={`inline-flex rounded-md px-2 py-1 text-[12px] leading-4 font-medium ${PRIORITY_PILL[item.priority]}`}
                      >
                        {PRIORITY_LABEL[item.priority]}
                      </span>
                    </td>

                    <td className={`${CELL} ${lit("status")}`}>
                      <span className="inline-flex rounded-md bg-[#eaf1fe] px-2 py-1 text-[12px] leading-4 font-medium text-[#2563eb]">
                        {STATUS_LABEL[item.status]}
                      </span>
                    </td>

                    <td className={`${CELL} text-[13px] whitespace-nowrap text-slate-400`}>
                      {relativeTime(item.updated_at, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RevealFooter
        label="View all cases"
        expandedLabel="Show recent cases"
        expanded={expanded}
        hasMore={matching.length > RECENT_ROWS}
        onToggle={() => setExpanded((value) => !value)}
      />
    </Card>
  );
}
