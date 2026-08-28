"use client";

/**
 * Row three, left: call volume over a window, from
 * `/api/stats/call-volume?days=N`. The total, the change and every bar are the
 * server's numbers; the window selector is the only thing this component owns.
 */

import { Card, CardHeader, PanelEmpty, Shimmer } from "./ui";
import { BarChart, type BarChartBar } from "./charts";
import { ChevronDownIcon } from "./icons";
import { percentText, type CallVolume } from "@/lib/stats";

export const VOLUME_WINDOWS = [7, 14, 30];

/** `2026-08-27` -> `Aug 27`, without dragging the string through a timezone. */
function axisLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CallVolumePanel({
  volume,
  days,
  onDaysChange,
  loading,
  error,
}: {
  volume: CallVolume | null;
  days: number;
  onDaysChange: (days: number) => void;
  loading: boolean;
  error: string | null;
}) {
  const bars: BarChartBar[] = (volume?.buckets ?? []).map((bucket, index, all) => ({
    label: axisLabel(bucket.date),
    value: bucket.count,
    highlighted: index === all.length - 1,
    title: `${axisLabel(bucket.date)}: ${bucket.count} call${bucket.count === 1 ? "" : "s"}`,
  }));

  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Call Volume"
        action={
          <div className="relative">
            <select
              value={days}
              onChange={(event) => onDaysChange(Number(event.target.value))}
              aria-label="Call volume window"
              className="h-8 appearance-none rounded-lg border border-[#e2e5ea] bg-white pr-7 pl-3 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none"
            >
              {VOLUME_WINDOWS.map((window) => (
                <option key={window} value={window}>
                  {window} days
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          </div>
        }
      />

      <div className="flex flex-1 flex-col px-5 pb-5">
        {loading ? (
          <div className="space-y-4">
            <Shimmer className="h-9 w-24" />
            <Shimmer className="h-[132px] w-full" />
          </div>
        ) : error || !volume || bars.length === 0 ? (
          <PanelEmpty
            title="No call volume to show"
            hint={error ?? "The analytics service returned no daily buckets for this window."}
          />
        ) : (
          <div className="flex flex-1 flex-col">
            <div className="flex items-end gap-3">
              <span className="text-[30px] leading-9 font-semibold tracking-tight tabular-nums text-slate-900">
                {volume.total}
              </span>
              {volume.changePercent !== null ? (
                <span
                  className={`pb-1.5 text-[13px] font-medium tabular-nums ${
                    volume.changePercent >= 0 ? "text-[#16a34a]" : "text-[#dc2626]"
                  }`}
                >
                  {percentText(volume.changePercent)}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Total calls
              {volume.changePercent !== null ? (
                <span className="text-slate-400"> · vs previous {days} days</span>
              ) : null}
            </p>

            <div className="mt-5 flex-1">
              <BarChart bars={bars} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
