"use client";

/**
 * Row three, right: the actionable groups from `/api/stats/needs-attention`.
 * Every count, title and line of detail is the server's; an empty response
 * means there is genuinely nothing waiting, and says so.
 */

import { useState } from "react";
import { Card, CardHeader, PanelEmpty, RevealFooter, Shimmer } from "./ui";
import { AlertIcon, ChevronRightIcon } from "./icons";
import type { AttentionGroup } from "@/lib/stats";

const ALERT_ROWS = 3;

export function NeedsAttentionPanel({
  groups,
  loading,
  error,
}: {
  groups: AttentionGroup[] | null;
  loading: boolean;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // The API returns every group it knows about, including the ones sitting at
  // zero. A zero is good news, not an alert, so it does not get a red row.
  const all = (groups ?? []).filter((group) => group.count > 0);
  const shown = expanded ? all : all.slice(0, ALERT_ROWS);

  return (
    <Card className="flex flex-col">
      <CardHeader title="Needs Attention" />

      <div className="flex-1 px-5 pb-5">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Shimmer key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <PanelEmpty title="Alerts could not be loaded" hint={error} />
        ) : all.length === 0 ? (
          <PanelEmpty title="Nothing needs attention" hint="No case is escalated, stalled or waiting on a resident." />
        ) : (
          <ul className="space-y-3">
            {shown.map((group) => (
              <li
                key={group.key}
                className="flex items-start gap-3 rounded-xl border border-[#f6dcda] bg-[#fdf2f1] px-3.5 py-3"
              >
                <span className="mt-0.5 shrink-0 text-[#dc2626]" aria-hidden>
                  <AlertIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-5 font-semibold text-slate-900">
                    <span className="tabular-nums">{group.count}</span> {group.title}
                  </p>
                  {group.detail ? (
                    <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{group.detail}</p>
                  ) : null}
                </div>
                <ChevronRightIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
              </li>
            ))}
          </ul>
        )}
      </div>

      <RevealFooter
        label="View all alerts"
        expandedLabel="Show fewer alerts"
        expanded={expanded}
        hasMore={all.length > ALERT_ROWS}
        onToggle={() => setExpanded((value) => !value)}
      />
    </Card>
  );
}
