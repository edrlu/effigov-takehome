"use client";

/**
 * Row one: four headline tiles, each fed by one metric from
 * `/api/stats/summary`. A metric the API did not return renders as an
 * unavailable tile - never as a stand-in number.
 */

import type { ReactNode } from "react";
import { Card, Shimmer } from "./ui";
import { Sparkline } from "./charts";
import { ClockIcon, FolderIcon, PhoneIcon, TrendUpIcon } from "./icons";
import { deltaTone, signed, SUMMARY_KEYS, type Summary, type SummaryKey, type SummaryMetric } from "@/lib/stats";

interface TileSpec {
  key: SummaryKey;
  label: string;
  icon: ReactNode;
  iconClass: string;
  spark: string;
  /** What the delta is measured against, when the API does not word it itself. */
  comparison: string;
  /**
   * Shown in place of a delta. Live calls is a snapshot of who is on the line
   * right now, so a day-over-day change would be comparing two different
   * questions.
   */
  subtitle?: string;
  format: (value: number) => string;
}

const wholeNumber = (value: number) => `${Math.round(value)}`;

const TILES: TileSpec[] = [
  {
    key: "open_cases",
    label: "Open Cases",
    icon: <FolderIcon />,
    iconClass: "bg-[#e8f0fe] text-[#2563eb]",
    spark: "#16a34a",
    comparison: "from yesterday",
    format: wholeNumber,
  },
  {
    key: "live_calls",
    label: "Live Calls",
    icon: <PhoneIcon />,
    iconClass: "bg-[#e6f6ed] text-[#16a34a]",
    spark: "#16a34a",
    comparison: "from yesterday",
    subtitle: "Now active",
    format: wholeNumber,
  },
  {
    key: "avg_resolution_days",
    label: "Avg Resolution Time",
    icon: <ClockIcon />,
    iconClass: "bg-[#f0eafe] text-[#7c3aed]",
    spark: "#7c3aed",
    comparison: "vs last 7 days",
    format: (value) => `${(Math.round(value * 10) / 10).toFixed(1)}d`,
  },
  {
    key: "escalations",
    label: "Escalations",
    icon: <TrendUpIcon />,
    iconClass: "bg-[#fdf1dd] text-[#d97706]",
    spark: "#f97316",
    comparison: "vs yesterday",
    format: wholeNumber,
  },
];

const TONE_CLASS = {
  good: "text-[#16a34a]",
  bad: "text-[#dc2626]",
  flat: "text-slate-400",
} as const;

function Tile({ spec, metric }: { spec: TileSpec; metric: SummaryMetric | undefined }) {
  const tone = metric ? deltaTone(spec.key, metric.delta) : "flat";
  // A tile with its own subtitle says that instead of a delta.
  const showDelta = metric !== undefined && spec.subtitle === undefined && metric.delta !== null;

  return (
    <Card className="flex items-center gap-3.5 px-4 py-4">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${spec.iconClass}`}
        aria-hidden
      >
        {spec.icon}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] leading-4 font-medium text-slate-500">{spec.label}</p>
        <p className="mt-0.5 text-[26px] leading-8 font-semibold tracking-tight tabular-nums text-slate-900">
          {metric ? spec.format(metric.value) : "-"}
        </p>
        {metric === undefined ? (
          <p className="mt-0.5 truncate text-[12px] leading-4 text-slate-400">Unavailable</p>
        ) : showDelta && metric.delta !== null ? (
          <p className={`mt-0.5 truncate text-[12px] leading-4 font-medium ${TONE_CLASS[tone]}`}>
            <span className="tabular-nums">{signed(metric.delta)}</span>{" "}
            <span className="font-normal text-slate-400">{metric.deltaLabel ?? spec.comparison}</span>
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[12px] leading-4 text-slate-400">{spec.subtitle ?? "No comparison yet"}</p>
        )}
      </div>

      <div className="shrink-0">
        {metric && metric.series.length > 1 ? (
          <Sparkline points={metric.series} stroke={spec.spark} className="h-[34px] w-[76px]" />
        ) : (
          <div className="h-[34px] w-[76px]" />
        )}
      </div>
    </Card>
  );
}

export function StatTiles({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SUMMARY_KEYS.map((key) => (
          <Card key={key} className="flex items-center gap-3.5 px-4 py-4">
            <Shimmer className="h-10 w-10 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Shimmer className="h-3 w-24" />
              <Shimmer className="h-6 w-16" />
              <Shimmer className="h-3 w-20" />
            </div>
            <Shimmer className="h-[34px] w-[76px]" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {TILES.map((spec) => (
        <Tile key={spec.key} spec={spec} metric={summary?.[spec.key]} />
      ))}
    </div>
  );
}
