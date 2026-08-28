"use client";

/**
 * Row three, middle: the issue-type mix from `/api/stats/cases-by-type`. The
 * donut, the legend counts and the percentages are all the server's slices,
 * including its folded `Other`.
 */

import { useState } from "react";
import { Card, CardHeader, PanelEmpty, RevealFooter, Shimmer } from "./ui";
import { Donut, DONUT_COLORS, type DonutSlice } from "./charts";
import type { CasesByType } from "@/lib/stats";

/**
 * Legend rows shown before the footer link opens the rest. The API folds its
 * tail into `Other` at six slices, so in practice the legend shows the lot.
 */
const LEGEND_ROWS = 6;

export function CasesByTypePanel({
  breakdown,
  loading,
  error,
}: {
  breakdown: CasesByType | null;
  loading: boolean;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const slices: DonutSlice[] = (breakdown?.slices ?? []).map((slice, index) => ({
    key: slice.key,
    label: slice.label,
    value: slice.count,
    color: DONUT_COLORS[index % DONUT_COLORS.length],
  }));
  const legend = expanded ? slices : slices.slice(0, LEGEND_ROWS);
  const percentOf = (key: string) => breakdown?.slices.find((slice) => slice.key === key)?.percent ?? 0;

  return (
    <Card className="flex flex-col">
      <CardHeader title="Cases by Type" />

      <div className="flex-1 px-5 pb-5">
        {loading ? (
          <div className="flex items-center gap-5">
            <Shimmer className="h-[150px] w-[150px] rounded-full" />
            <div className="flex-1 space-y-3">
              {Array.from({ length: 4 }, (_, index) => (
                <Shimmer key={index} className="h-3 w-full" />
              ))}
            </div>
          </div>
        ) : error || !breakdown || slices.length === 0 ? (
          <PanelEmpty
            title="No case types to show"
            hint={error ?? "No cases have been classified into an issue type yet."}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-5">
            <Donut slices={slices} total={breakdown.total} />
            <ul className="min-w-[150px] flex-1 space-y-2.5">
              {legend.map((slice) => (
                <li key={slice.key} className="flex items-center gap-2.5 text-[13px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
                  <span className="min-w-0 flex-1 truncate text-slate-600">{slice.label}</span>
                  <span className="shrink-0 font-medium tabular-nums text-slate-900">{slice.value}</span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-slate-400">
                    {Math.round(percentOf(slice.key))}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <RevealFooter
        label="View full analytics"
        expandedLabel="Show top types"
        expanded={expanded}
        hasMore={slices.length > LEGEND_ROWS}
        onToggle={() => setExpanded((value) => !value)}
      />
    </Card>
  );
}
