"use client";

/**
 * What the voice agent has managed to pull out of the conversation so far.
 *
 * A row is either captured or it is not: captured rows show the value and a
 * green check, uncaptured rows show a muted placeholder and no check. Nothing
 * here invents a value to fill a gap, because a staff member reading this panel
 * is deciding whether the agent actually heard the address.
 */

import type { ReactNode } from "react";
import { CardHeading, ConsoleCard, LiveDot, Pill } from "@/components/call/surface";
import {
  BuildingIcon,
  CheckCircleIcon,
  FlagIcon,
  ListIcon,
  PersonIcon,
  PhoneIcon,
  PinIcon,
  TagIcon,
} from "@/components/call/icons";
import { PRIORITY_CHIP_LABEL, displayPhone } from "@/lib/callConsole";
import { STATUS_LABEL, departmentLabel, issueLabel } from "@/lib/labels";
import { caseLocation, type Call, type Case, type Report } from "@/lib/types";
import type { ExtractedField } from "@/lib/useCallConsole";

interface RowSpec {
  key: ExtractedField;
  label: string;
  icon: ReactNode;
  value: string | null;
  /** A pill instead of plain text, for the three classification rows. */
  pill?: string;
}

const ICON_CLASS = "h-4 w-4 shrink-0 text-slate-400";

export function ExtractedInfo({
  call,
  kase,
  report,
  flashed,
}: {
  call: Call | null;
  kase: Case | null;
  report: Report | null;
  flashed: ReadonlySet<ExtractedField>;
}) {
  const name = report?.reporter_name ?? call?.caller_name ?? kase?.caller_name ?? null;
  const phone = displayPhone(call?.caller_phone ?? report?.reporter_phone ?? kase?.phone, call?.caller_phone_display);
  // `issue_type` is only set once the backend's confidence gate passed, so its
  // presence is exactly the "we are sure enough" signal the check should mean.
  const issue = kase?.issue_type ? issueLabel(kase.issue_type) : null;
  const location = kase ? caseLocation(kase) : null;

  const rows: RowSpec[] = [
    { key: "name", label: "Name", icon: <PersonIcon className={ICON_CLASS} />, value: name },
    { key: "phone", label: "Phone", icon: <PhoneIcon className={ICON_CLASS} />, value: phone },
    { key: "issue_type", label: "Issue Type", icon: <TagIcon className={ICON_CLASS} />, value: issue },
    { key: "location", label: "Location", icon: <PinIcon className={ICON_CLASS} />, value: location },
    {
      key: "status",
      label: "Status",
      icon: <ListIcon className={ICON_CLASS} />,
      value: kase ? STATUS_LABEL[kase.status] : null,
      pill: "bg-blue-50 text-blue-700",
    },
    {
      key: "department",
      label: "Department",
      icon: <BuildingIcon className={ICON_CLASS} />,
      value: kase && kase.department && kase.department !== "unassigned" ? departmentLabel(kase.department) : null,
      pill: "bg-purple-50 text-purple-700",
    },
    {
      key: "priority",
      label: "Priority",
      icon: <FlagIcon className={ICON_CLASS} />,
      value: kase ? PRIORITY_CHIP_LABEL[kase.priority] : null,
      pill: "bg-amber-50 text-amber-700",
    },
  ];

  return (
    // Every row is a fixed height and the panel has no variable content, so it
    // is the same rectangle empty as it is fully captured.
    <ConsoleCard className="shrink-0 px-5 py-[18px]">
      <CardHeading
        title="Extracted Information"
        action={
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600">
            <LiveDot />
            Live
          </span>
        }
      />

      <dl className="mt-2 divide-y divide-slate-100">
        {rows.map((row) => (
          <div
            key={row.key}
            // A fixed row height so the list does not jolt when a placeholder is
            // replaced by a taller pill mid-call.
            className={`-mx-2 flex h-11 items-center gap-2.5 rounded-md px-2 ${flashed.has(row.key) ? "cc-flash" : ""}`}
          >
            {row.icon}
            <dt className="shrink-0 text-[13px] text-slate-500">{row.label}</dt>
            <dd className="ml-auto flex min-w-0 items-center justify-end gap-2">
              {row.value === null ? (
                <span className="truncate text-[13px] text-slate-300 italic">Not captured yet</span>
              ) : row.pill ? (
                <Pill tone={row.pill}>{row.value}</Pill>
              ) : (
                <span className="truncate text-right text-[13px] font-medium text-slate-900">{row.value}</span>
              )}
              {/* The slot is always reserved so every row shares one right
                  edge. The pills carry their own state, so a check beside them
                  would be noise; the four free-text rows are where "did the
                  agent actually get this?" is a real question. */}
              <span className="h-4 w-4 shrink-0">
                {row.pill === undefined && row.value !== null ? (
                  <CheckCircleIcon className="cc-check-in h-4 w-4 text-emerald-500" />
                ) : null}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </ConsoleCard>
  );
}
